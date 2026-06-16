'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──
const API_BASE = 'https://api.bitget.com';
const DEMO_BALANCE = 10000;
const CAPITAL_PCT = 0.01;        // 1% per trade
const LEVERAGE = 20;
const SL_PCT = 1 / LEVERAGE;     // 5% SL
const TP_PCT = SL_PCT * 3;       // 15% TP (1:3)
const TAKER_FEE = 0.0006;        // 0.06% taker fee
const TOP_PAIRS = 10;            // top 10 gainers + top 10 losers
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 3;
const MIN_VOLUME = 100000;

// Timeframes: each is independent
const TIMEFRAMES = [
  { name: '15m', granularity: '15m', scanMs: 900000,   label: '15m' },
  { name: '1H',  granularity: '1H',  scanMs: 3600000,   label: '1H'  },
  { name: '4H',  granularity: '4H',  scanMs: 14400000,  label: '4H'  },
];

// ── State ──
let balance = DEMO_BALANCE;
let equity = DEMO_BALANCE;
let totalFees = 0;
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

function fl2(v) { return Math.round((v || 0) * 100) / 100; }
function fl4(v) { return Math.round((v || 0) * 10000) / 10000; }

// ── Public Bitget API ──
async function publicGet(path) {
  try {
    const res = await fetch(API_BASE + path);
    const data = await res.json();
    if (data.code !== '00000') return null;
    return data.data;
  } catch (_) { return null; }
}

async function getAllTickers() {
  return await publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
}

async function getCandles(symbol, granularity) {
  return await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=60`);
}

async function getTicker(symbol) {
  const d = await publicGet(`/api/v2/mix/market/tickers?productType=USDT-FUTURES&symbol=${symbol}`);
  return Array.isArray(d) && d.length > 0 ? d[0] : null;
}

// ── Top gainers & losers ──
let lastPairRefresh = 0;
let activeSymbols = [];

async function refreshTopPairs() {
  if (Date.now() - lastPairRefresh < 300000 && activeSymbols.length > 0) return;
  const tickers = await getAllTickers();
  if (!Array.isArray(tickers)) return;

  const usdt = tickers.filter(t => t.symbol.endsWith('USDT') && parseFloat(t.usdtVolume || 0) >= MIN_VOLUME);
  
  // Calculate 24h % change
  const withChange = usdt.map(t => {
    const last = parseFloat(t.lastPr || 0);
    const open = parseFloat(t.open24h || 0);
    const chg = open > 0 ? ((last - open) / open) * 100 : 0;
    return { symbol: t.symbol, change: chg, price: last, volume: parseFloat(t.usdtVolume || 0) };
  }).filter(t => t.price > 0);

  // Sort by change
  withChange.sort((a, b) => b.change - a.change);

  const gainers = withChange.slice(0, TOP_PAIRS);
  const losers = withChange.slice(-TOP_PAIRS).reverse();

  activeSymbols = [...new Set([...gainers.map(t => t.symbol), ...losers.map(t => t.symbol)])];
  lastPairRefresh = Date.now();
  logFn(`📋 Top ${TOP_PAIRS} gainers + ${TOP_PAIRS} losers (${activeSymbols.length} pairs)`);

  // Log top/bottom
  if (gainers.length > 0) logFn(`📈 Top: ${gainers[0].symbol} +${fl2(gainers[0].change)}%`);
  if (losers.length > 0) logFn(`📉 Bottom: ${losers[0].symbol} ${fl2(losers[0].change)}%`);
}

// ── EMA ──
function calcEMA(values, period) {
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

// ── Check pair on timeframe ──
async function checkPairTimeframe(symbol, tf) {
  const candles = await getCandles(symbol, tf.granularity);
  if (!Array.isArray(candles) || candles.length < 36) return null;
  const close = candles.map(c => parseFloat(c[4])).filter(p => p > 0);
  const macd = detectMACDCross(close);
  if (!macd) return null;
  const price = parseFloat(candles[candles.length - 1][4]) || 0;
  return {
    symbol, price, macd,
    signal: macd.goldenCross ? 'BUY' : (macd.deathCross ? 'SELL' : null),
    timeframe: tf.name,
  };
}

// ── Simulate Trade ──
function simulateTrade(signal) {
  const side = signal.signal;
  if (!side) return;

  // Check for existing position on same symbol + timeframe
  if (positions.some(p => p.symbol === signal.symbol && p.timeframe === signal.timeframe)) return;
  // 1 trade per symbol per TF per 24h
  if (trades.some(t => t.symbol === signal.symbol && t.timeframe === signal.timeframe && (Date.now() - (t.closeTime || t.time) < 86400000))) return;

  const isBuy = side === 'BUY';
  const entry = signal.price;
  const sl = isBuy ? fl4(entry * (1 - SL_PCT)) : fl4(entry * (1 + SL_PCT));
  const tp = isBuy ? fl4(entry * (1 + TP_PCT)) : fl4(entry * (1 - TP_PCT));
  const margin = fl2(DEMO_BALANCE * CAPITAL_PCT); // fixed $100

  if (balance < margin) return;
  balance = fl2(balance - margin);
  equity = fl2(balance);

  const size = fl2(margin * LEVERAGE);
  const contracts = fl2(size / entry);
  if (contracts <= 0) return;

  const entryFee = fl2(size * TAKER_FEE);
  totalFees = fl4(totalFees + entryFee);
  balance = fl2(balance - entryFee);
  equity = fl2(balance);

  const btcSide = isBuy ? 'open_long' : 'open_short';

  const pos = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    symbol: signal.symbol, side: btcSide, direction: side,
    entryPrice: entry, slPrice: sl, tpPrice: tp,
    size, margin, contracts, timeframe: signal.timeframe,
    entryFee, time: Date.now(), status: 'open',
    unrealizedPnl: 0, markPrice: entry,
  };
  positions.push(pos);

  // Update monitored pair
  const pair = monitoredPairs.find(p => p.symbol === signal.symbol);
  if (pair) {
    pair.lastSignal = { side, entryPrice: entry, slPrice: sl, tpPrice: tp, timeframe: signal.timeframe, time: Date.now() };
  }

  signalLog.push({
    symbol: signal.symbol, side: btcSide, entryPrice: entry,
    timeframe: signal.timeframe, crossType: side === 'BUY' ? 'golden' : 'death',
    time: Date.now(),
  });
  if (signalLog.length > 200) signalLog = signalLog.slice(-200);

  logFn(`📊 ${side} ${signal.symbol} (${signal.timeframe}) | Entry: $${entry} | SL: $${sl} | TP: $${tp} | Size: ${contracts}c | Fee: $${entryFee}`);
  saveState();
  emitFn('snapshot', buildSnapshot());
}

// ── Check Price Updates for Positions ──
async function updatePrices() {
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (pos.status !== 'open') continue;

    const ticker = await getTicker(pos.symbol);
    const price = ticker ? (parseFloat(ticker.lastPr || ticker.markPrice || 0) || pos.entryPrice) : pos.entryPrice;
    pos.markPrice = price;

    const isLong = pos.direction === 'BUY';
    const diff = isLong ? (price - pos.entryPrice) : (pos.entryPrice - price);
    const pnlRaw = (diff / pos.entryPrice) * pos.size;
    pos.unrealizedPnl = fl2(pnlRaw);

    let closed = false;
    let pnl = 0;

    if (isLong && price <= pos.slPrice) {
      pnl = -pos.margin; // 1R loss
      closed = true;
    } else if (isLong && price >= pos.tpPrice) {
      pnl = fl2(pos.margin * 3); // 3R profit
      closed = true;
    } else if (!isLong && price >= pos.slPrice) {
      pnl = -pos.margin;
      closed = true;
    } else if (!isLong && price <= pos.tpPrice) {
      pnl = fl2(pos.margin * 3);
      closed = true;
    }

    if (closed) {
      // Exit fee
      const exitVal = pos.size + (pnl > 0 ? pnl : pnl); // position value at close
      const exitFee = fl2(pos.size * TAKER_FEE);
      totalFees = fl4(totalFees + exitFee);
      pnl = fl2(pnl - exitFee);

      pos.status = 'closed';
      pos.closeTime = Date.now();
      pos.pnl = pnl;
      totalRealizedPnl = fl4(totalRealizedPnl + pnl);
      balance = fl2(balance + pos.margin + pnl);
      equity = fl2(balance);

      if (pnl >= 0) wins++; else losses++;
      trades.push({ ...pos });
      if (trades.length > 200) trades = trades.slice(-200);
      positions.splice(i, 1);
      logFn(`${pnl >= 0 ? '🟢 TP' : '🔴 SL'} ${pos.symbol} (${pos.timeframe}) | PnL: ${fl2(pnl >= 0 ? pnl : -pnl)} | Fee: $${exitFee}`);
      saveState();
      emitFn('snapshot', buildSnapshot());
    }
  }
}

// ── Scan ──
let lastScan = {};

async function scan() {
  await refreshTopPairs();
  if (activeSymbols.length === 0) return;

  const now = Date.now();
  let scanned = 0;

  for (const tf of TIMEFRAMES) {
    const key = tf.name;
    if (now - (lastScan[key] || 0) < tf.scanMs) continue;
    lastScan[key] = now;

    for (const symbol of activeSymbols) {
      // Update monitored pair
      if (!monitoredPairs.some(m => m.symbol === symbol)) {
        monitoredPairs.push({ symbol, price: 0, macd: {}, lastSignal: null, lastCheck: 0 });
      }

      const pair = monitoredPairs.find(m => m.symbol === symbol);
      if (now - (pair.lastCheck || 0) < 30000) continue;
      pair.lastCheck = now;

      const signal = await checkPairTimeframe(symbol, tf);
      if (!signal) continue;
      pair.price = signal.price;
      if (!pair.macd) pair.macd = {};
      pair.macd[tf.name] = signal.macd;
      scanned++;

      if (signal.signal) {
        simulateTrade(signal);
      }
    }
  }

  if (scanned > 0) logFn(`✅ ${scanned} signals checked | Bal: $${fl2(balance)} | Pos: ${positions.length}`);
}

// ── State ──
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      stateVersion: STATE_VERSION, balance, totalRealizedPnl, totalFees, wins, losses,
      trades: trades.slice(-200), positions: positions.filter(p => p.status === 'open'),
      signalLog: signalLog.slice(-200),
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
        wins = d.wins || 0; losses = d.losses || 0;
        trades = d.trades || [];
        positions = (d.positions || []).filter(p => p.status === 'open');
        signalLog = d.signalLog || [];
      } else { balance = DEMO_BALANCE; }
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
    totalFees: fl4(totalFees),
    wins, losses,
    totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4((wins / (wins + losses)) * 100) : 0,
    positions: positions.filter(p => p.status === 'open').map(p => ({
      symbol: p.symbol, side: p.side, direction: p.direction,
      entryPrice: p.entryPrice, slPrice: p.slPrice, tpPrice: p.tpPrice,
      size: p.size, margin: p.margin, contracts: p.contracts,
      timeframe: p.timeframe, unrealizedPnl: p.unrealizedPnl || 0,
      markPrice: p.markPrice || 0, entryFee: p.entryFee || 0,
    })),
    pairs: monitoredPairs.map(p => ({
      symbol: p.symbol, price: p.price,
      macd15m: p.macd?.['15m'] || null,
      macd1H: p.macd?.['1H'] || null,
      macd4H: p.macd?.['4H'] || null,
      lastSignal: p.lastSignal,
    })),
    signals: signalLog.slice(-40).reverse(),
    trades: trades.slice(-40).reverse(),
    timeframes: TIMEFRAMES.map(t => t.name),
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
  logFn(`✅ MACD Bot v${STATE_VERSION} | DEMO $${fl2(balance)} | 15m/1H/4H`);
  logFn(`📊 1% margin | 20x leverage | 1:3 R:R | Top gainers+losers | Fees 0.06%`);
  setTimeout(tick, 1000);
  setInterval(tick, 60000);
  emitFn('snapshot', buildSnapshot());
}

module.exports = { start, buildSnapshot };
