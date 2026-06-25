'use strict';

// ── Bitget Signal Trading Bot ─────────────────────────────────────────────
// Monitors Telegram for trading signals → executes on Bitget USDT-M futures
// Tracks source accuracy → scales position size based on performance

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseSignal } = require('./signal-parser');

// ── Config ───────────────────────────────────────────────────────────────────
const DEMO_BALANCE     = 5000;
const CAPITAL_PCT      = 0.02;   // 2% per trade
const LEVERAGE         = 20;
const TAKER_FEE        = 0.0006;
const STATE_FILE       = path.join(__dirname, 'state.json');
const STATE_VERSION    = 20;
const POLL_INTERVAL_MS = 15000;  // Telegram poll every 15s
const PRICE_CHECK_MS   = 5000;   // Position monitor every 5s
const MAX_LIFETIME_MS  = 7 * 86400000; // Auto-close after 7 days
const MIN_ACCURACY     = 0.60;   // Pause source below 60%

// ── Accuracy → Position size ────────────────────────────────────────────────
function sizeForSource(sourceStats) {
  if (!sourceStats || sourceStats.total < 10) {
    return { pct: 0.005, label: '0.5% (probation)' };     // < 10 signals: test mode
  }
  const acc = sourceStats.wins / sourceStats.total;
  if (acc >= 0.85) return { pct: 0.03,  label: '3% (high confidence)' };
  if (acc >= 0.70) return { pct: 0.02,  label: '2% (normal)' };
  if (acc >= 0.60) return { pct: 0.01,  label: '1% (low confidence)' };
  return { pct: 0,     label: 'PAUSED (< 60%)' };
}

// ── Bitget Auth ──────────────────────────────────────────────────────────────
const BITGET_API_KEY       = process.env.BITGET_API_KEY || '';
const BITGET_API_SECRET    = process.env.BITGET_API_SECRET || '';
const BITGET_API_PASSPHRASE = process.env.BITGET_API_PASSPHRASE || '';
const API_BASE = 'https://api.bitget.com';

// Check if Bitget API is configured for LIVE trading
const HAS_BITGET_CREDS = !!(BITGET_API_KEY && BITGET_API_SECRET && BITGET_API_PASSPHRASE);

function sign(method, path, bodyStr, timestamp) {
  const signStr = timestamp + method + path + (bodyStr || '');
  return crypto.createHmac('sha256', BITGET_API_SECRET).update(signStr).digest('base64');
}

function bitgetHeaders(method, path, body) {
  const timestamp = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  return {
    'ACCESS-KEY': BITGET_API_KEY,
    'ACCESS-SIGN': sign(method, path, bodyStr, timestamp),
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': BITGET_API_PASSPHRASE,
    'Content-Type': 'application/json',
  };
}

async function bitgetGet(path) {
  const url = API_BASE + path;
  const opts = { method: 'GET', headers: bitgetHeaders('GET', path) };
  try {
    const r = await fetch(url, opts);
    const d = await r.json();
    return d.code === '00000' ? d.data : null;
  } catch (_) { return null; }
}

async function bitgetPost(path, body) {
  const url = API_BASE + path;
  const opts = { method: 'POST', headers: bitgetHeaders('POST', path, body), body: JSON.stringify(body) };
  try {
    const r = await fetch(url, opts);
    const d = await r.json();
    return d.code === '00000' ? d.data : null;
  } catch (_) { return null; }
}

async function publicGet(path) {
  try {
    const r = await fetch(API_BASE + path);
    const d = await r.json();
    return d.code === '00000' ? d.data : null;
  } catch (_) { return null; }
}

// ── Bitget Market helpers ──────────────────────────────────────────────────
async function getTicker(symbol) {
  // Use singular ticker with productType (plural tickers endpoint also works)
  const d = await publicGet('/api/v2/mix/market/ticker?symbol=' + symbol + '&productType=USDT-FUTURES');
  return d && Array.isArray(d) ? d[0] : d;
}

async function getContractInfo(symbol) {
  const data = await publicGet('/api/v2/mix/market/contracts?productType=USDT-FUTURES');
  if (!Array.isArray(data)) return null;
  return data.find(c => c.symbol === symbol) || null;
}

// ── Bitget Trading ─────────────────────────────────────────────────────────
async function setLeverage(symbol) {
  if (!HAS_BITGET_CREDS) return false;
  return bitgetPost('/api/v2/mix/account/set-leverage', {
    symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
    leverage: String(LEVERAGE), holdSide: 'long',
  });
}

async function placeBitgetOrder(symbol, side, size, orderType = 'market', price = '0') {
  if (!HAS_BITGET_CREDS) {
    logFn('⚠️ No Bitget API keys — sim mode only');
    return { simulated: true, size, side, symbol };
  }
  const body = {
    symbol, productType: 'USDT-FUTURES', marginMode: 'isolated', marginCoin: 'USDT',
    side: side.toLowerCase(), orderType, size: String(size), 
    timeInForceValue: orderType === 'limit' ? 'GTC' : undefined,
    price: orderType === 'limit' ? String(price) : undefined,
  };
  return bitgetPost('/api/v2/mix/order/place-order', body);
}

async function cancelBitgetOrder(symbol, orderId) {
  if (!HAS_BITGET_CREDS) return null;
  return bitgetPost('/api/v2/mix/order/cancel-order', { symbol, productType: 'USDT-FUTURES', orderId });
}

// ── Runtime state ────────────────────────────────────────────────────────────
let balance          = DEMO_BALANCE;
let totalRealizedPnl = 0;
let totalFees        = 0;
let wins             = 0;
let losses           = 0;
let positions        = [];     // { id, sourceId, pair, direction, entryPrice, tp, sl, size, margin, time, status, ... }
let closedTrades     = [];     // closed positions
let sourceStats      = {};     // { [sourceId]: { total, wins, losses, lastSeen } }
let processedSignals = {};    // { [msgId]: true }
let signalLog        = [];
let emitFn           = () => {};
let logFn            = () => {};
let startTime        = Date.now();

const fl2 = v => Math.round((v || 0) * 100) / 100;
const fl4 = v => Math.round((v || 0) * 10000) / 10000;

// ── Telegram Watcher ─────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

async function getTelegramUpdates(offset) {
  if (!TELEGRAM_TOKEN) return [];
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=10`
    );
    const d = await r.json();
    return d.ok ? d.result : [];
  } catch (_) { return []; }
}

let telegramOffset = 0;

async function pollTelegram() {
  if (!TELEGRAM_TOKEN) return;
  const updates = await getTelegramUpdates(telegramOffset);
  for (const u of updates) {
    telegramOffset = u.update_id + 1;

    // Messages from channels, groups, or direct
    const msg = u.channel_post || u.message;
    if (!msg || !msg.text) continue;

    // Dedup
    const msgKey = String(u.update_id) + ':' + msg.chat.id + ':' + msg.message_id + ':' + msg.text.slice(0, 50);
    if (processedSignals[msgKey]) continue;
    processedSignals[msgKey] = true;

    const sourceId = String(msg.chat.id);
    const sourceName = msg.chat.title || msg.chat.username || 'Unknown';

    // Parse signal
    const signal = parseSignal(msg.text);
    if (!signal) continue;

    logFn(`📩 Signal from ${sourceName}: ${signal.direction} ${signal.pair} (entry:${signal.entry||'mkt'} tp:${signal.tp||'?'} sl:${signal.sl||'?'})`);

    // Must have at least TP
    if (!signal.tp) {
      logFn(`⚠️  Skipped ${signal.pair} — no TP in signal`);
      continue;
    }

    // Process the signal
    await executeSignal(sourceId, sourceName, signal, msgKey);
  }
}

// ── Signal Execution ─────────────────────────────────────────────────────────
async function executeSignal(sourceId, sourceName, signal, msgKey) {
  const stats = sourceStats[sourceId] || { total: 0, wins: 0, losses: 0, lastSeen: 0 };
  const sizing = sizeForSource(stats);
  
  // Skip if source paused
  if (sizing.pct === 0) {
    logFn(`⏸️  Skipped ${signal.pair} — source ${sourceName} accuracy below 60% (${fl2(stats.wins/stats.total*100)}%)`);
    return;
  }

  // Get current price for entry and contract info
  const pairSymbol = signal.pair + 'USDT';
  const ticker = await getTicker(pairSymbol);
  const currentPrice = ticker ? parseFloat(ticker.lastPr || 0) : 0;
  if (!currentPrice) {
    logFn(`⚠️  Cannot get price for ${pairSymbol}`);
    return;
  }

  const entryPrice = signal.entry || currentPrice;

  // Validate: entry must be reasonable vs current price (within 20%)
  const priceRatio = Math.abs(entryPrice - currentPrice) / currentPrice;
  if (priceRatio > 0.20) {
    logFn(`⚠️  Entry $${entryPrice} too far from market $${currentPrice} (${fl2(priceRatio*100)}%) — skipping`);
    return;
  }

  // Get min trade size for this pair
  const contract = await getContractInfo(pairSymbol);
  const minSize = contract ? parseFloat(contract.minTradeNum || '0.001') : 0.001;
  const sizeStep = contract ? parseFloat(contract.priceEndStep || '0.001') : 0.001;

  // Position sizing
  const margin = fl2(balance * sizing.pct);
  if (margin < 1) {
    logFn(`⚠️  Balance too low ($${fl2(balance)}) for $${margin} margin`);
    return;
  }
  const positionValue = margin * LEVERAGE;
  let size = fl4(positionValue / entryPrice);

  // Round to contract step
  size = Math.floor(size / sizeStep) * sizeStep;
  if (size < minSize) size = minSize;

  // Place order (simulated if no API keys)
  const orderResult = await placeBitgetOrder(pairSymbol, signal.direction === 'LONG' ? 'buy' : 'sell', size);
  
  // Track position
  const pos = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    msgKey, sourceId, sourceName,
    pair: pairSymbol, direction: signal.direction,
    entryPrice, currentPrice, tp: signal.tp, sl: signal.sl,
    size, margin,
    time: Date.now(), status: 'open',
    unrealizedPnl: 0, pnl: null, exitReason: null,
    entryFee: fl2(positionValue * TAKER_FEE),
    orderResult,
  };

  totalFees = fl4(totalFees + pos.entryFee);
  balance = fl2(balance - pos.entryFee);
  positions.push(pos);

  signalLog.push({
    sourceId, sourceName, msgKey,
    pair: signal.pair, direction: signal.direction,
    entryPrice, tp: signal.tp, sl: signal.sl,
    time: Date.now(),
  });
  if (signalLog.length > 200) signalLog = signalLog.slice(-200);

  logFn(`📊 ${signal.direction} ${pairSymbol} @ $${entryPrice} | margin:$${margin} sz:${size} | TP:$${signal.tp} SL:$${signal.sl||'?'} (${sizing.label})`);
  saveState();
  emitFn('snapshot', buildSnapshot());
}

// ── Position Monitor ─────────────────────────────────────────────────────────
async function monitorPositions() {
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (pos.status !== 'open') continue;

    const ticker = await getTicker(pos.pair);
    const price = ticker ? parseFloat(ticker.lastPr || 0) : 0;
    if (!price) continue;
    pos.currentPrice = price;

    // Calculate PnL
    const isLong = pos.direction === 'LONG';
    const diff = isLong ? (price - pos.entryPrice) : (pos.entryPrice - price);
    pos.unrealizedPnl = fl2((diff / pos.entryPrice) * pos.size * LEVERAGE * pos.entryPrice);
    // Simplified: position value change
    const posValue = pos.size * pos.entryPrice;
    const currentValue = pos.size * price;
    const change = isLong ? (currentValue - posValue) : (posValue - currentValue);
    pos.unrealizedPnl = fl2(change);

    let closed = false, reason = '';
    let exitPrice = price;

    // TP hit
    if (pos.tp && ((isLong && price >= pos.tp) || (!isLong && price <= pos.tp))) {
      exitPrice = pos.tp;
      closed = true;
      reason = 'TP';
    }
    // SL hit
    if (pos.sl && ((isLong && price <= pos.sl) || (!isLong && price >= pos.sl))) {
      exitPrice = pos.sl;
      closed = true;
      reason = 'SL';
    }
    // Timeout
    if (!closed && (Date.now() - pos.time) > MAX_LIFETIME_MS) {
      closed = true;
      reason = 'TIMEOUT';
    }

    if (closed) {
      const exitFee = fl2(pos.size * exitPrice * TAKER_FEE);
      const changeClosed = isLong ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice);
      const grossPnl = fl2(changeClosed * pos.size);
      const netPnl = fl2(grossPnl - pos.entryFee - exitFee);
      
      totalFees = fl4(totalFees + exitFee);
      totalRealizedPnl = fl4(totalRealizedPnl + netPnl);
      balance = fl2(balance + grossPnl - exitFee);

      pos.status = 'closed';
      pos.closeTime = Date.now();
      pos.pnl = netPnl;
      pos.exitReason = reason;
      pos.exitPrice = exitPrice;

      // Update source accuracy
      const stats = sourceStats[pos.sourceId] || { total: 0, wins: 0, losses: 0, lastSeen: 0 };
      stats.total++;
      if (reason === 'TP') stats.wins++;
      else stats.losses++;
      stats.lastSeen = Date.now();
      sourceStats[pos.sourceId] = stats;

      if (netPnl >= 0) wins++; else losses++;
      closedTrades.push({ ...pos });
      if (closedTrades.length > 500) closedTrades = closedTrades.slice(-500);
      positions.splice(i, 1);

      const emoji = netPnl >= 0 ? '🟢' : '🔴';
      logFn(`${emoji} ${reason} ${pos.pair} ${pos.direction} | Entry:$${pos.entryPrice} Exit:$${exitPrice} | PnL:$${fl2(netPnl)}`);
      saveState();
      emitFn('snapshot', buildSnapshot());
    }
  }
}

// ── Manual signal entry (for dashboard) ─────────────────────────────────────
async function manualSignal(signal) {
  await executeSignal('manual', 'Manual Entry', signal, 'manual:' + Date.now());
}

// ── State persistence ───────────────────────────────────────────────────────
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      stateVersion: STATE_VERSION,
      balance, totalRealizedPnl, totalFees, wins, losses,
      positions: positions.filter(p => p.status === 'open'),
      closedTrades: closedTrades.slice(-300),
      sourceStats, signalLog: signalLog.slice(-200),
      processedSignals: Object.fromEntries(
        Object.entries(processedSignals).slice(-1000)
      ),
    }, null, 2));
  } catch (_) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (d.stateVersion === STATE_VERSION) {
        balance = d.balance || DEMO_BALANCE;
        totalRealizedPnl = d.totalRealizedPnl || 0;
        totalFees = d.totalFees || 0;
        wins = d.wins || 0;
        losses = d.losses || 0;
        positions = (d.positions || []).filter(p => p.status === 'open');
        closedTrades = d.closedTrades || [];
        sourceStats = d.sourceStats || {};
        signalLog = d.signalLog || [];
        processedSignals = d.processedSignals || {};
      } else {
        balance = DEMO_BALANCE;
      }
    }
  } catch (_) {}
}

// ── Dashboard snapshot ─────────────────────────────────────────────────────
function buildSnapshot() {
  const totalEquity = fl2(balance);
  const totalTrades = wins + losses;

  // Source accuracy summary
  const sourceSummary = Object.entries(sourceStats).map(([id, s]) => ({
    id,
    total: s.total,
    wins: s.wins,
    losses: s.losses,
    accuracy: s.total > 0 ? fl4((s.wins / s.total) * 100) : 0,
    lastSeen: s.lastSeen,
    active: s.total < 10 ? 'probation' : (s.wins / s.total >= 0.6 ? 'active' : 'paused'),
    sizeLabel: sizeForSource(s).label,
  }));

  return {
    balance: totalEquity,
    available: fl2(balance),
    totalPnl: fl4(totalRealizedPnl),
    totalFees: fl4(totalFees),
    wins, losses, totalTrades,
    winRate: totalTrades > 0 ? fl4((wins / totalTrades) * 100) : 0,
    positions: positions.filter(p => p.status === 'open').map(p => ({
      id: p.id,
      sourceName: p.sourceName,
      pair: p.pair,
      direction: p.direction,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice || 0,
      tp: p.tp,
      sl: p.sl,
      size: p.size,
      margin: p.margin,
      unrealizedPnl: p.unrealizedPnl || 0,
      time: p.time,
      age: Math.floor((Date.now() - p.time) / 1000),
    })),
    trades: closedTrades.slice(-40).reverse().map(t => ({
      symbol: t.pair,
      direction: t.direction,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice || 0,
      pnl: t.pnl,
      margin: t.margin,
      exitReason: t.exitReason,
      sourceName: t.sourceName,
      time: t.time,
      closeTime: t.closeTime,
    })),
    signals: signalLog.slice(-40).reverse(),
    sources: sourceSummary,
    telegram: !!TELEGRAM_TOKEN,
    bitget: HAS_BITGET_CREDS,
    demo: !HAS_BITGET_CREDS,
    strategy: 'Telegram Signals',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activePositions: positions.filter(p => p.status === 'open').length,
    capitalPct: CAPITAL_PCT,
    leverage: LEVERAGE,
    demoBalance: DEMO_BALANCE,
  };
}

// ── Main loop ───────────────────────────────────────────────────────────────
async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  loadState();

  logFn(`✅ Signal Bot v${STATE_VERSION} | ${HAS_BITGET_CREDS ? 'LIVE' : 'DEMO'} | ${CAPITAL_PCT*100}% × ${LEVERAGE}x`);

  if (!TELEGRAM_TOKEN) {
    logFn('⚠️  TELEGRAM_BOT_TOKEN not set — use dashboard to enter signals manually');
  } else {
    logFn('🤖 Telegram watcher active');
  }

  emitFn('snapshot', buildSnapshot());

  // Poll Telegram
  setInterval(pollTelegram, POLL_INTERVAL_MS);
  setTimeout(pollTelegram, 1000);

  // Monitor positions
  const monitorLoop = async () => {
    try {
      await monitorPositions();
      emitFn('snapshot', buildSnapshot());
    } catch (e) {
      logFn('⚠️ Monitor: ' + e.message);
    }
  };
  setInterval(monitorLoop, PRICE_CHECK_MS);
  setTimeout(monitorLoop, 2000);

  // Periodic state save
  setInterval(saveState, 30000);
}

// ── Exported helpers ───────────────────────────────────────────────────────
async function submitManual(dir, pair, entry, tp, sl) {
  if (!dir || !pair) return { error: 'Direction and pair required' };
  const signal = { direction: dir.toUpperCase(), pair: pair.toUpperCase().replace('USDT', ''), entry, tp, sl };
  const parsed = { ...signal, entry: parseFloat(entry) || null, tp: parseFloat(tp) || null, sl: parseFloat(sl) || null };
  if (!parsed.tp && !parsed.sl) return { error: 'TP or SL required' };
  await manualSignal(parsed);
  return { ok: true };
}

module.exports = { start, buildSnapshot, runBacktest: () => {}, submitManual };
