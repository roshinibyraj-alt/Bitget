'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──
const API_BASE = 'https://api.bitget.com';
const DEMO_BALANCE = 10000;
const CAPITAL_PCT = 0.01;      // 1% per trade
const LEVERAGE = 20;
const SL_PCT = 1 / LEVERAGE;   // 5% SL
const TP_PCT = SL_PCT * 3;     // 15% TP (1:3)
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 2;
const MIN_VOLUME_USD = 1000000;

// ── State ──
let balance = DEMO_BALANCE;
let equity = DEMO_BALANCE;
let totalRealizedPnl = 0;
let wins = 0;
let losses = 0;
let trades = [];         // completed trades
let positions = [];      // open positions
let monitoredPairs = [];
let signalLog = [];
let emitFn = (e, d) => {};
let logFn = (m) => {};
let startTime = Date.now();

function fl2(v) { return Math.round((v || 0) * 100) / 100; }
function fl4(v) { return Math.round((v || 0) * 10000) / 10000; }

// ── Public Bitget API (only candles + tickers) ──
async function publicGet(path) {
  try {
    const res = await fetch(API_BASE + path);
    const data = await res.json();
    if (data.code !== '00000') return null;
    return data.data;
  } catch (_) { return null; }
}

async function getAllPairs() {
  const data = await publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  if (!Array.isArray(data)) return [];
  return data.filter(c => c.symbol.endsWith('USDT') && parseFloat(c.usdtVolume || c.volume || 0) >= MIN_VOLUME_USD);
}

async function getCandles(symbol, granularity) {
  return await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=60`);
}

// ── MACD ──
function ema(values, period) {
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < values.length; i++) sum += values[i];
  let e = sum / Math.min(period, values.length);
  for (let i = Math.min(period, values.length); i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function detectMACDCross(prices) {
  if (prices.length < 36) return null;
  const macdVals = [];
  let e12 = 0, e26 = 0;
  for (let i = 0; i < 12; i++) e12 += prices[i];
  for (let i = 0; i < 26; i++) e26 += prices[i];
  e12 /= 12; e26 /= 26;
  for (let i = 26; i < prices.length; i++) {
    e12 = prices[i] * (2/13) + e12 * (11/13);
    e26 = prices[i] * (2/27) + e26 * (25/27);
    macdVals.push(e12 - e26);
  }
  if (macdVals.length < 10) return null;

  let sig = 0;
  for (let i = 0; i < 9; i++) sig += macdVals[i];
  sig /= 9;
  for (let i = 9; i < macdVals.length; i++) sig = macdVals[i] * (2/10) + sig * (8/10);

  let prevSig = 0;
  for (let i = 0; i < 9; i++) prevSig += macdVals[i];
  prevSig /= 9;
  for (let i = 9; i < macdVals.length - 1; i++) prevSig = macdVals[i] * (2/10) + prevSig * (8/10);

  const curM = macdVals[macdVals.length - 1], curS = sig;
  const prevM = macdVals[macdVals.length - 2], prevS = prevSig;

  return {
    macd: curM, signal: curS, histogram: curM - curS,
    goldenCross: prevM < prevS && curM > curS,
    deathCross: prevM > prevS && curM < curS,
  };
}

// ── Check pair ──
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
    dSignal: dMACD.goldenCross ? 'BUY' : (dMACD.deathCross ? 'SELL' : null),
    h4Signal: h4MACD ? (h4MACD.goldenCross ? 'BUY' : (h4MACD.deathCross ? 'SELL' : null)) : null,
  };
}

// ── Simulate Trade ──
function simulateTrade(signal, timeframe) {
  const side = signal.dSignal || signal.h4Signal;
  if (!side) return;

  if (positions.some(p => p.symbol === signal.symbol)) return;
  if (trades.some(t => t.symbol === signal.symbol && t.timeframe === timeframe && (Date.now() - (t.closeTime || t.time) < 86400000))) return;

  const isBuy = side === 'BUY';
  const entry = signal.price;
  const sl = isBuy ? fl4(entry * (1 - SL_PCT)) : fl4(entry * (1 + SL_PCT));
  const tp = isBuy ? fl4(entry * (1 + TP_PCT)) : fl4(entry * (1 - TP_PCT));
  const margin = fl2(DEMO_BALANCE * CAPITAL_PCT); // fixed 1% of base capital
  const size = fl2(margin * LEVERAGE);
  const contracts = fl2(size / entry);
  if (contracts <= 0 || margin <= 0) return;

  const btcSide = isBuy ? 'open_long' : 'open_short';

  // balance unchanged on entry, margin reserved virtually
  equity = fl2(balance);

  const pos = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    symbol: signal.symbol, side: btcSide, direction: side,
    entryPrice: entry, slPrice: sl, tpPrice: tp,
    size, margin, contracts, timeframe,
    time: Date.now(), status: 'open',
    unrealizedPnl: 0, markPrice: entry,
  };
  positions.push(pos);

  signalLog.push({
    symbol: signal.symbol, side: btcSide, entryPrice: entry,
    timeframe, crossType: side === 'BUY' ? 'golden' : 'death',
    time: Date.now(),
  });
  if (signalLog.length > 100) signalLog = signalLog.slice(-100);

  const pair = monitoredPairs.find(p => p.symbol === signal.symbol);
  if (pair) pair.lastSignal = { side, entryPrice: entry, slPrice: sl, tpPrice: tp, timeframe, time: Date.now() };

  logFn(`📊 ${side} ${signal.symbol} | Entry: $${entry} | SL: $${sl} | TP: $${tp} | Size: ${contracts}c ($${fl2(size)}) | ${timeframe}`);
  saveState();
  emitFn('snapshot', buildSnapshot());
}

// ── Check Price Updates for Positions ──
async function updatePrices() {
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (pos.status !== 'open') continue;

    // Fetch current price from ticker
    const tickers = await publicGet(`/api/v2/mix/market/tickers?productType=USDT-FUTURES&symbol=${pos.symbol}`);
    let price = pos.entryPrice;
    if (Array.isArray(tickers) && tickers.length > 0) {
      price = parseFloat(tickers[0].lastPr || tickers[0].close || 0) || pos.entryPrice;
    }

    pos.markPrice = price;
    const isLong = pos.direction === 'BUY';
    const diff = isLong ? (price - pos.entryPrice) : (pos.entryPrice - price);
    pos.unrealizedPnl = fl2((diff / pos.entryPrice) * pos.size);

    // Check SL / TP
    let closed = false;
    if (isLong && price <= pos.slPrice) {
      // SL hit
      const loss = pos.margin; // 1R loss (full margin)
      pos.pnl = -loss;
      closed = true;
      logFn(`🔴 SL ${pos.symbol} | Loss: -$${loss}`);
    } else if (isLong && price >= pos.tpPrice) {
      // TP hit
      const profit = fl2(pos.margin * 3); // 3R profit
      pos.pnl = profit;
      closed = true;
      logFn(`🟢 TP ${pos.symbol} | Profit: +$${profit}`);
    } else if (!isLong && price >= pos.slPrice) {
      const loss = fl2(pos.margin * 0.95);
      pos.pnl = -loss;
      closed = true;
      logFn(`🔴 SL ${pos.symbol} | Loss: -$${loss}`);
    } else if (!isLong && price <= pos.tpPrice) {
      const profit = fl2(pos.margin * 2.85);
      pos.pnl = profit;
      closed = true;
      logFn(`🟢 TP ${pos.symbol} | Profit: +$${profit}`);
    }

    if (closed) {
      pos.status = 'closed';
      pos.closeTime = Date.now();
      totalRealizedPnl = fl4(totalRealizedPnl + pos.pnl);
      balance = fl2(balance + pos.margin + pos.pnl);
      equity = fl2(balance);
      if (pos.pnl >= 0) wins++; else losses++;
      trades.push({ ...pos });
      if (trades.length > 100) trades = trades.slice(-100);
      positions.splice(i, 1);
      saveState();
      emitFn('snapshot', buildSnapshot());
    }
  }
}

// ── Scan ──
let last1dScan = 0, last4hScan = 0;

async function scan() {
  const now = Date.now();
  if (now - last1dScan < 3600000 && now - last4hScan < 14400000) return;
  const s1d = now - last1dScan >= 3600000;
  const s4h = now - last4hScan >= 14400000;

  logFn(`🔍 Scanning... ${s1d ? '1D ' : ''}${s4h ? '4H' : ''}`);
  const pairs = await getAllPairs();
  if (pairs.length === 0) return;

  for (const p of pairs) {
    if (!monitoredPairs.some(m => m.symbol === p.symbol)) {
      monitoredPairs.push({ symbol: p.symbol, price: 0, macd1d: null, macd4h: null, lastSignal: null, lastCheck: 0 });
    }
  }
  if (monitoredPairs.length > 200) monitoredPairs = monitoredPairs.slice(-200);

  let scanned = 0;
  const batch = monitoredPairs.slice(0, 30); // max 30 pairs per scan
  for (const pair of batch) {
    if (now - pair.lastCheck < 60000) continue;
    pair.lastCheck = now;
    const signal = await checkPair(pair.symbol);
    if (!signal) continue;
    pair.price = signal.price;
    pair.macd1d = signal.d1;
    if (signal.h4) pair.macd4h = signal.h4;
    scanned++;

    if (s1d && signal.dSignal) simulateTrade(signal, '1D');
    if (s4h && signal.h4Signal) simulateTrade(signal, '4H');
  }

  if (s1d) last1dScan = now;
  if (s4h) last4hScan = now;
  logFn(`✅ Scanned ${scanned}/${monitoredPairs.length} pairs | Bal: $${fl2(balance)}`);
}

// ── State ──
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      stateVersion: STATE_VERSION, balance, totalRealizedPnl, wins, losses,
      trades: trades.slice(-100), positions: positions.filter(p => p.status === 'open'),
      signalLog: signalLog.slice(-100),
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
        wins = d.wins || 0; losses = d.losses || 0;
        trades = d.trades || [];
        positions = (d.positions || []).filter(p => p.status === 'open');
        signalLog = d.signalLog || [];
      } else {
        balance = DEMO_BALANCE;
      }
    }
  } catch (_) {}
}

// ── Snapshot ──
function buildSnapshot() {
  const openUpl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  return {
    balance: fl2(balance),
    equity: fl2(balance + openUpl),
    totalPnl: fl4(totalRealizedPnl + openUpl),
    realizedPnl: fl4(totalRealizedPnl),
    unrealizedPnl: fl4(openUpl),
    wins, losses,
    totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4((wins / (wins + losses)) * 100) : 0,
    positions: positions.filter(p => p.status === 'open').map(p => ({
      symbol: p.symbol, side: p.side, direction: p.direction,
      entryPrice: p.entryPrice, slPrice: p.slPrice, tpPrice: p.tpPrice,
      size: p.size, margin: p.margin, contracts: p.contracts,
      timeframe: p.timeframe, unrealizedPnl: p.unrealizedPnl || 0,
      markPrice: p.markPrice || 0,
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
    signals: signalLog.slice(-30).reverse(),
    trades: trades.slice(-30).reverse(),
    demo: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activePairs: positions.filter(p => p.status === 'open').length,
  };
}

// ── Tick ──
async function tick() {
  try {
    await scan();
    await updatePrices();
    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    logFn(`⚠️ Tick: ${e.message}`);
  }
}

// ── Start ──
async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  loadState();

  logFn(`✅ MACD Bot v${STATE_VERSION} | DEMO $${fl2(balance)}`);
  logFn(`📊 1% margin | 20x leverage | 1:3 R:R | Internal simulation`);

  // First scan deferred to avoid blocking server
  setTimeout(tick, 1000);
  setInterval(tick, 60000);
  emitFn('snapshot', buildSnapshot());
}

module.exports = { start, buildSnapshot };
