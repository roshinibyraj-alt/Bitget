'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Config ──
const API_BASE = 'https://api.bitget.com';
const CAPITAL_PCT = 0.01;
const LEVERAGE = 20;
const RR_RATIO = 3;
const SL_PCT = 1 / LEVERAGE;
const TP_PCT = SL_PCT * RR_RATIO;
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 1;
const MIN_VOLUME_USD = 5000000;

const API_KEY = process.env.BITGET_API_KEY || '';
const SECRET = process.env.BITGET_SECRET_KEY || '';
const PASSPHRASE = process.env.BITGET_PASSPHRASE || '';
const DRY_RUN = process.env.DRY_RUN === 'true';
const CAN_TRADE = !!(API_KEY && SECRET && PASSPHRASE) && !DRY_RUN;

// ── State ──
let balance = 10000;
let equity = 10000;
let totalRealizedPnl = 0;
let wins = 0;
let losses = 0;
let trades = [];
let positions = [];
let monitoredPairs = [];
let signalLog = [];
let emitFn = (e, d) => {};
let logFn = (m) => {};
let startTime = Date.now();
let pairsCache = [];
let lastPairsFetch = 0;

function fl2(v) { return Math.round((v || 0) * 100) / 100; }
function fl4(v) { return Math.round((v || 0) * 10000) / 10000; }

// ── Bitget API (V2) ──
async function signedRequest(method, path, body = '') {
  const ts = Date.now().toString();
  const msg = ts + method.toUpperCase() + path + (body ? JSON.stringify(body) : '');
  const sign = crypto.createHmac('sha256', SECRET).update(msg).digest('base64');
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        'ACCESS-KEY': API_KEY,
        'ACCESS-SIGN': sign,
        'ACCESS-TIMESTAMP': ts,
        'ACCESS-PASSPHRASE': PASSPHRASE,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (data.code !== '00000') {
      logFn(`⚠️ API ${data.code}: ${data.msg || ''}`);
      return null;
    }
    return data.data;
  } catch (e) {
    logFn(`⚠️ API error: ${e.message}`);
    return null;
  }
}

async function publicGet(path) {
  try {
    const res = await fetch(API_BASE + path);
    const data = await res.json();
    if (data.code !== '00000') return null;
    return data.data;
  } catch (_) { return null; }
}

// ── Get all USDT-M pairs ──
async function getAllPairs() {
  if (Date.now() - lastPairsFetch < 300000 && pairsCache.length > 0) return pairsCache;
  const data = await publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  if (!Array.isArray(data)) return pairsCache;
  pairsCache = data.filter(c => c.symbol.endsWith('USDT') && parseFloat(c.usdtVolume || c.volume || 0) >= MIN_VOLUME_USD);
  lastPairsFetch = Date.now();
  return pairsCache;
}

// ── Get candles ──
async function getCandles(symbol, granularity) {
  return await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=60`);
}

// ── Get account ──
async function getAccount() {
  const data = await signedRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
  if (Array.isArray(data)) {
    const acct = data.find(a => a.marginCoin === 'USDT');
    if (acct) {
      balance = fl2(parseFloat(acct.equity || acct.available || 0));
      equity = fl2(parseFloat(acct.equity || 0));
    }
  }
}

// ── Get open positions ──
async function getOpenPositions() {
  return await signedRequest('GET', '/api/v2/mix/position/allPosition?productType=USDT-FUTURES');
}

// ── Place order ──
async function placeOrder(symbol, side, marginCoin, size, slPrice, tpPrice) {
  const body = {
    symbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin,
    side,
    orderType: 'market',
    size: size.toString(),
    leverage: LEVERAGE.toString(),
    presetStopSurplusPrice: tpPrice.toString(),
    presetStopLossPrice: slPrice.toString(),
  };
  if (DRY_RUN) {
    logFn(`📋 DRY: ${side} ${symbol} size=${size} SL=${slPrice} TP=${tpPrice}`);
    return { orderId: 'dry_' + Date.now() };
  }
  return await signedRequest('POST', '/api/v2/mix/order/place-order', body);
}

// ── EMA ──
function ema(values, period) {
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < values.length; i++) sum += values[i];
  let e = sum / Math.min(period, values.length);
  for (let i = Math.min(period, values.length); i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

// ── MACD Cross Detection ──
function detectMACDCross(prices) {
  if (prices.length < 36) return null;

  // Compute running EMA12 and EMA26 from scratch to get MACD line history
  const macdVals = [];
  let e12 = 0, e26 = 0;
  for (let i = 0; i < 12; i++) e12 += prices[i];
  for (let i = 0; i < 26; i++) e26 += prices[i];
  e12 /= 12; e26 /= 26;

  for (let i = Math.min(26, prices.length); i < prices.length; i++) {
    e12 = prices[i] * (2/13) + e12 * (11/13);
    e26 = prices[i] * (2/27) + e26 * (25/27);
    macdVals.push(e12 - e26);
  }

  if (macdVals.length < 10) return null;

  // Signal = EMA9 of MACD
  let sig = 0;
  for (let i = 0; i < 9; i++) sig += macdVals[i];
  sig /= 9;
  for (let i = 9; i < macdVals.length; i++) {
    sig = macdVals[i] * (2/10) + sig * (8/10);
  }

  // Previous signal
  let prevSig = 0;
  if (macdVals.length >= 10) {
    for (let i = 0; i < 9; i++) prevSig += macdVals[i];
    prevSig /= 9;
    for (let i = 9; i < macdVals.length - 1; i++) {
      prevSig = macdVals[i] * (2/10) + prevSig * (8/10);
    }
  }

  const curM = macdVals[macdVals.length - 1];
  const curS = sig;
  const prevM = macdVals.length >= 2 ? macdVals[macdVals.length - 2] : null;
  const prevS = macdVals.length >= 10 ? prevSig : null;

  return {
    macd: curM, signal: curS, histogram: curM - curS,
    goldenCross: prevM !== null && prevS !== null && prevM < prevS && curM > curS,
    deathCross: prevM !== null && prevS !== null && prevM > prevS && curM < curS,
  };
}

// ── Check single pair ──
async function checkPair(symbol) {
  const dCandles = await getCandles(symbol, '1D');
  if (!Array.isArray(dCandles) || dCandles.length < 36) return null;
  const dClose = dCandles.map(c => parseFloat(c[4])).filter(p => p > 0);
  const dMACD = detectMACDCross(dClose);
  if (!dMACD) return null;

  const h4Candles = await getCandles(symbol, '4H');
  let h4MACD = null;
  if (Array.isArray(h4Candles) && h4Candles.length >= 36) {
    const h4Close = h4Candles.map(c => parseFloat(c[4])).filter(p => p > 0);
    h4MACD = detectMACDCross(h4Close);
  }

  const price = parseFloat(dCandles[dCandles.length - 1][4]) || 0;

  return {
    symbol, price, d1: dMACD, h4: h4MACD,
    dCross: dMACD.goldenCross || dMACD.deathCross,
    h4Cross: h4MACD ? (h4MACD.goldenCross || h4MACD.deathCross) : false,
    dSignal: dMACD.goldenCross ? 'BUY' : (dMACD.deathCross ? 'SELL' : null),
    h4Signal: h4MACD ? (h4MACD.goldenCross ? 'BUY' : (h4MACD.deathCross ? 'SELL' : null)) : null,
  };
}

// ── Execute trade ──
async function executeSignal(signal, timeframe) {
  if (!signal.dSignal && !signal.h4Signal) return;
  const side = signal.dSignal || signal.h4Signal;
  if (!side) return;

  if (positions.some(p => p.symbol === signal.symbol)) {
    logFn(`⏭️ ${signal.symbol} already in position`);
    return;
  }
  if (trades.some(t => t.symbol === signal.symbol && t.timeframe === timeframe && (Date.now() - t.time < 86400000))) {
    logFn(`⏭️ ${signal.symbol} already traded today`);
    return;
  }

  const isBuy = side === 'BUY';
  const entry = signal.price;
  const sl = isBuy ? fl4(entry * (1 - SL_PCT)) : fl4(entry * (1 + SL_PCT));
  const tp = isBuy ? fl4(entry * (1 + TP_PCT)) : fl4(entry * (1 - TP_PCT));
  const margin = fl2(Math.max(1, balance * CAPITAL_PCT));
  const size = fl2(margin * LEVERAGE);
  const contracts = fl2(size / entry);

  if (contracts <= 0 || margin <= 0) return;

  const btcSide = isBuy ? 'open_long' : 'open_short';
  logFn(`📊 SIGNAL: ${signal.symbol} ${btcSide} | Entry: $${entry} | SL: $${sl} | TP: $${tp} | Size: ${contracts}c ($${fl2(size)}) | ${timeframe}`);

  // Update monitored pair
  const pair = monitoredPairs.find(p => p.symbol === signal.symbol);
  if (pair) pair.lastSignal = { side, entryPrice: entry, slPrice: sl, tpPrice: tp, timeframe, time: Date.now() };

  const result = await placeOrder(signal.symbol, btcSide, 'USDT', contracts, sl, tp);
  if (!result && !DRY_RUN) { logFn(`❌ Order failed for ${signal.symbol}`); return; }

  const trade = {
    id: result?.orderId || `sig_${Date.now()}`,
    symbol: signal.symbol, side: btcSide, entryPrice: entry,
    slPrice: sl, tpPrice: tp, size, margin, timeframe,
    time: Date.now(), pnl: 0, status: 'open',
  };

  positions.push(trade);
  signalLog.push({
    symbol: signal.symbol, side: btcSide, entryPrice: entry,
    timeframe, crossType: side === 'BUY' ? 'golden' : 'death', time: Date.now()
  });
  if (signalLog.length > 100) signalLog = signalLog.slice(-100);
  logFn(`✅ ORDER: ${signal.symbol} ${btcSide} @ $${entry}`);
  saveState();
  emitFn('snapshot', buildSnapshot());
}

// ── Monitor positions ──
async function monitorPositions() {
  if (!CAN_TRADE) return;
  const remote = await getOpenPositions();
  if (!Array.isArray(remote)) return;

  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (pos.status !== 'open') continue;
    const rp = remote.find(r => r.symbol === pos.symbol);
    if (!rp || parseFloat(rp.total || 0) <= 0) {
      pos.status = 'closed';
      pos.closeTime = Date.now();
      pos.pnl = fl2(parseFloat(rp?.closedPnl || 0));
      if (pos.pnl >= 0) wins++; else losses++;
      totalRealizedPnl = fl4(totalRealizedPnl + pos.pnl);
      trades.push({ ...pos });
      if (trades.length > 100) trades = trades.slice(-100);
      logFn(`🔒 CLOSED: ${pos.symbol} | PnL: $${pos.pnl}`);
      positions.splice(i, 1);
      saveState();
    } else {
      pos.unrealizedPnl = fl2(parseFloat(rp.unrealizedPnl || 0));
      pos.markPrice = parseFloat(rp.markPrice || 0);
    }
  }
}

// ── Main scan ──
let last1dScan = 0, last4hScan = 0;

async function scan() {
  const now = Date.now();
  if (now - last1dScan < 3600000 && now - last4hScan < 14400000) return;
  const scan1D = now - last1dScan >= 3600000;
  const scan4H = now - last4hScan >= 14400000;

  logFn(`🔍 Scanning... (1D:${scan1D} 4H:${scan4H})`);
  const pairs = await getAllPairs();
  if (pairs.length === 0) return;

  // Update monitored pair list
  for (const p of pairs) {
    if (!monitoredPairs.some(m => m.symbol === p.symbol)) {
      monitoredPairs.push({ symbol: p.symbol, price: 0, macd1d: null, macd4h: null, lastSignal: null, lastCheck: 0 });
    }
  }
  if (monitoredPairs.length > 100) monitoredPairs = monitoredPairs.slice(-100);

  // Scan each pair
  let scanned = 0;
  for (const pair of monitoredPairs) {
    if (now - pair.lastCheck < 60000) continue;
    pair.lastCheck = now;
    const signal = await checkPair(pair.symbol);
    if (!signal) continue;
    pair.price = signal.price;
    pair.macd1d = signal.d1;
    if (signal.h4) pair.macd4h = signal.h4;
    scanned++;

    if (scan1D && signal.dSignal) await executeSignal(signal, '1D');
    if (scan4H && signal.h4Signal) await executeSignal(signal, '4H');
  }

  if (scan1D) last1dScan = now;
  if (scan4H) last4hScan = now;
  logFn(`✅ Scanned ${scanned}/${monitoredPairs.length} pairs`);
}

// ── State ──
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      stateVersion: STATE_VERSION, balance, totalRealizedPnl, wins, losses,
      trades: trades.slice(-100),
      positions: positions.filter(p => p.status === 'open'),
      signalLog: signalLog.slice(-100),
    }, null, 2));
  } catch (_) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (d.stateVersion === STATE_VERSION) {
        balance = d.balance || 10000;
        totalRealizedPnl = d.totalRealizedPnl || 0;
        wins = d.wins || 0; losses = d.losses || 0;
        trades = d.trades || [];
        positions = (d.positions || []).filter(p => p.status === 'open');
        signalLog = d.signalLog || [];
      }
    }
  } catch (_) {}
}

// ── Snapshot ──
function buildSnapshot() {
  const openUpl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  return {
    balance: fl2(balance),
    equity: fl2(balance + totalRealizedPnl + openUpl),
    totalPnl: fl4(totalRealizedPnl + openUpl),
    realizedPnl: fl4(totalRealizedPnl),
    unrealizedPnl: fl4(openUpl),
    wins, losses,
    totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4((wins / (wins + losses)) * 100) : 0,
    positions: positions.filter(p => p.status === 'open').map(p => ({
      symbol: p.symbol, side: p.side, entryPrice: p.entryPrice,
      slPrice: p.slPrice, tpPrice: p.tpPrice,
      size: p.size, margin: p.margin, timeframe: p.timeframe,
      unrealizedPnl: p.unrealizedPnl || 0,
      markPrice: p.markPrice || 0, status: p.status,
    })),
    pairs: monitoredPairs.map(p => ({
      symbol: p.symbol, price: p.price,
      macd1d: p.macd1d ? {
        macd: fl4(p.macd1d.macd), signal: fl4(p.macd1d.signal),
        histogram: fl4(p.macd1d.histogram),
        goldenCross: !!p.macd1d.goldenCross, deathCross: !!p.macd1d.deathCross,
      } : null,
      macd4h: p.macd4h ? {
        macd: fl4(p.macd4h.macd), signal: fl4(p.macd4h.signal),
        histogram: fl4(p.macd4h.histogram),
        goldenCross: !!p.macd4h.goldenCross, deathCross: !!p.macd4h.deathCross,
      } : null,
      lastSignal: p.lastSignal,
    })),
    signals: signalLog.slice(-20).reverse(),
    trades: trades.slice(-30).reverse(),
    canTrade: CAN_TRADE, dryRun: DRY_RUN,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activePairs: positions.filter(p => p.status === 'open').length,
  };
}

// ── Tick ──
async function tick() {
  try {
    if (CAN_TRADE) await getAccount();
    await scan();
    if (CAN_TRADE) await monitorPositions();
    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    logFn(`⚠️ Tick: ${e.message}`);
  }
}

// ── Start ──
async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  loadState();

  if (!CAN_TRADE && balance === 0) balance = 10000;
  const mode = CAN_TRADE ? 'LIVE TRADING 🔴' : (DRY_RUN ? 'DRY RUN 🟡' : 'SIGNAL ONLY 🔵');
  logFn(`✅ Bitget MACD Bot v${STATE_VERSION} | ${mode}`);
  logFn(`📊 1% margin | 20x leverage | 1:3 R:R | $${fl2(balance)} balance`);

  await tick();
  setInterval(tick, 60000);
  emitFn('snapshot', buildSnapshot());
}

module.exports = { start, buildSnapshot };
