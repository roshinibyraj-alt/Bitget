'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.bitget.com';
const DEMO_BALANCE = 30000;
const CAPITAL_PCT = 0.02; // 2% per trade
const LEVERAGE = 5;
const TAKER_FEE = 0.0006;
const MAX_PAIRS = 30;
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 10;

const TIMEFRAMES = [
  { name: '1D', granularity: '1D', scanMs: 86400000 },
];

// ── State ──
let balance = DEMO_BALANCE;
let lockedMargin = 0;
let totalFees = 0;
let totalRealizedPnl = 0;
let wins = 0;
let losses = 0;
let trades = [];
let positions = [];
let monitoredPairs = [];
let signalLog = [];
let processedCandles = {};
let emitFn = (e, d) => {};
let logFn = (m) => {};
let startTime = Date.now();

function fl2(v) { return Math.round((v || 0) * 100) / 100; }
function fl4(v) { return Math.round((v || 0) * 10000) / 10000; }

async function publicGet(path) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    const res = await fetch(API_BASE + path, { signal: c.signal });
    clearTimeout(t);
    const d = await res.json();
    return d.code === '00000' ? d.data : null;
  } catch (_) { return null; }
}

async function getCandles(symbol, granularity, limit) {
  return await publicGet('/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=' + symbol + '&granularity=' + granularity + '&limit=' + limit);
}

// ── EMA ──
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++)
    result = (values[i] - result) * k + result;
  return result;
}

// ── MACD ──
function macd(candles, fast = 12, slow = 26, signal = 9) {
  if (candles.length < slow + signal) return null;
  const closes = candles.map(c => parseFloat(c[4]));
  const macds = [];
  for (let i = slow; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    const fEma = ema(slice, fast);
    const sEma = ema(slice, slow);
    if (fEma !== null && sEma !== null) macds.push(fEma - sEma);
  }
  if (macds.length < signal + 1) return null;
  const signalEma = ema(macds, signal);
  return { macd: macds[macds.length - 1], signal: signalEma, histogram: macds[macds.length - 1] - signalEma };
}

// ── ATR ──
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let trs = [];
  for (let i = 1; i <= period; i++) {
    const h = parseFloat(candles[i][2]), l = parseFloat(candles[i][3]);
    const pc = parseFloat(candles[i - 1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((s, v) => s + v, 0) / period;
}

// ── MACD Signal ──
function checkMacdSignal(candles) {
  if (candles.length < 40) return null;
  const hist = [];
  for (let i = 0; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const m = macd(slice);
    if (m) hist.push(m.histogram);
  }
  if (hist.length < 2) return null;
  const prevHist = hist[hist.length - 2];
  const currHist = hist[hist.length - 1];
  const currMacd = macd(candles);

  if (prevHist < 0 && currHist >= 0) {
    return { direction: 'BUY', signalCandle: candles[candles.length - 1] };
  }
  if (prevHist > 0 && currHist <= 0) {
    return { direction: 'SELL', signalCandle: candles[candles.length - 1] };
  }
  return null;
}

// ── ATR-based SL and trailing TP ──
function calcSL(signalCandle, direction, entry) {
  const slPct = 0.15; // 15% wide SL (catastrophic protection only)
  if (direction === 'BUY') return entry * (1 - slPct);
  return entry * (1 + slPct);
}

function calcTrailingStop(entry, currentPrice, direction) {
  const profitPct = Math.abs((currentPrice - entry) / entry);
  if (profitPct > 0.08) { // trail after 8% profit
    const trailDist = entry * 0.03;
    if (direction === 'BUY') return currentPrice - trailDist;
    return currentPrice + trailDist;
  }
  return null;
}

// ── Process Signal ──
function processSignal(symbol, signal) {
  const sc = signal.signalCandle;
  const ts = parseInt(sc[0]);
  const key = symbol + ':macd1d:' + ts;
  if (processedCandles[key]) return;
  processedCandles[key] = true;

  const isBuy = signal.direction === 'BUY';
  const entry = parseFloat(sc[4]); // close of signal candle
  if (!entry) return;

  const equity = fl2(balance + positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0));
  const margin = fl2(equity * CAPITAL_PCT);
  if (equity - lockedMargin < margin * 0.5) return;

  const size = fl2(margin * LEVERAGE);
  if (size <= 0) return;

  const entryFee = fl2(size * TAKER_FEE);
  totalFees = fl4(totalFees + entryFee);
  balance = fl2(balance - entryFee);

  const sl = calcSL(sc, signal.direction, entry);
  if (isBuy && entry <= sl) return;
  if (!isBuy && entry >= sl) return;

  const pos = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    symbol, direction: signal.direction,
    entryPrice: entry, slPrice: sl,
    size, margin, entryFee, timeframe: '1D',
    time: Date.now(), status: 'open', unrealizedPnl: 0, markPrice: entry,
    trailingStop: null,
  };
  lockedMargin = fl2(lockedMargin + margin);
  positions.push(pos);

  const pair = monitoredPairs.find(p => p.symbol === symbol);
  if (pair) pair.lastSignal = signal.direction;

  signalLog.push({
    symbol, direction: signal.direction, entryPrice: entry,
    timeframe: '1D', time: Date.now(),
  });
  if (signalLog.length > 200) signalLog = signalLog.slice(-200);

  logFn('📊 ' + signal.direction + ' ' + symbol + ' (MACD) | Entry: $' + entry + ' | SL: $' + fl2(sl));
  saveState();
  emitFn('snapshot', buildSnapshot());
}

// ── Update Positions ──
async function updatePositions() {
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (pos.status !== 'open') continue;

    const ticker = await getTicker(pos.symbol);
    const price = ticker ? (parseFloat(ticker.lastPr || ticker.markPrice || 0) || pos.entryPrice) : pos.entryPrice;
    pos.markPrice = price;

    const isLong = pos.direction === 'BUY';
    const diff = isLong ? (price - pos.entryPrice) : (pos.entryPrice - price);
    pos.unrealizedPnl = fl2((diff / pos.entryPrice) * pos.size);

    // Update trailing stop
    const trail = calcTrailingStop(pos.entryPrice, price, pos.direction);
    if (trail !== null) {
      pos.trailingStop = trail;
      // Tighten SL
      if (isLong && trail > pos.slPrice) pos.slPrice = trail;
      else if (!isLong && trail < pos.slPrice) pos.slPrice = trail;
    }

    let closed = false, pnl = 0, reason = '';

    if (isLong && price <= pos.slPrice) {
      pnl = fl2(((pos.slPrice - pos.entryPrice) / pos.entryPrice) * pos.size);
      reason = 'SL'; closed = true;
    } else if (!isLong && price >= pos.slPrice) {
      pnl = fl2(((pos.entryPrice - pos.slPrice) / pos.entryPrice) * pos.size);
      reason = 'SL'; closed = true;
    }
    // Trailing TP hit
    if (!closed && pos.trailingStop !== null && isLong && price <= pos.trailingStop) {
      pnl = fl2(((pos.trailingStop - pos.entryPrice) / pos.entryPrice) * pos.size);
      reason = 'TP'; closed = true;
    } else if (!closed && pos.trailingStop !== null && !isLong && price >= pos.trailingStop) {
      pnl = fl2(((pos.entryPrice - pos.trailingStop) / pos.entryPrice) * pos.size);
      reason = 'TP'; closed = true;
    }

    if (closed) {
      const exitFee = fl2(pos.size * TAKER_FEE);
      totalFees = fl4(totalFees + exitFee);
      pnl = fl2(pnl - exitFee);
      const netPnl = fl2(pnl - pos.entryFee);
      pos.status = 'closed';
      pos.closeTime = Date.now();
      pos.pnl = netPnl;
      pos.exitReason = reason;
      pos.exitPrice = price;
      totalRealizedPnl = fl4(totalRealizedPnl + netPnl);
      lockedMargin = fl2(lockedMargin - pos.margin);
      balance = fl2(balance + pnl);
      if (netPnl >= 0) wins++; else losses++;
      trades.push({ ...pos });
      if (trades.length > 500) trades = trades.slice(-500);
      positions.splice(i, 1);
      const emoji = pnl >= 0 ? '🟢' : '🔴';
      logFn(emoji + ' ' + reason + ' ' + pos.symbol + ' (MACD 1D) | Entry:$' + pos.entryPrice + ' Exit:$' + price + ' | PnL:$' + fl2(netPnl));
      saveState();
      emitFn('snapshot', buildSnapshot());
    }
  }
}

// ── Pair Selection (top 30 volatile) ──
let lastPairRefresh = 0;
let activeSymbols = [];

async function refreshPairs() {
  if (Date.now() - lastPairRefresh < 60000 && lastPairRefresh > 0) return;

  const [contracts, tickers] = await Promise.all([
    publicGet('/api/v2/mix/market/contracts?productType=USDT-FUTURES'),
    publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES')
  ]);
  if (!Array.isArray(contracts)) return;

  const contractSet = new Set(
    contracts.filter(c => c.symbol.endsWith('USDT') && c.symbolStatus === 'normal').map(c => c.symbol)
  );

  if (Array.isArray(tickers)) {
    const withVol = tickers
      .filter(t => contractSet.has(t.symbol))
      .map(t => {
        const high = parseFloat(t.high24h || 0), low = parseFloat(t.low24h || 0);
        const volume = parseFloat(t.usdtVolume || 0);
        const volPct = low > 0 ? ((high - low) / low) * 100 : 0;
        return { symbol: t.symbol, volPct, volume, price: parseFloat(t.lastPr || 0), change: parseFloat(t.change24h || 0) };
      })
      .filter(t => t.volume > 500000 && t.volPct > 0);
    withVol.sort((a, b) => b.volPct - a.volPct);
    activeSymbols = withVol.slice(0, MAX_PAIRS).map(t => t.symbol);

    // Pre-populate monitoredPairs
    const existing = new Set(monitoredPairs.map(p => p.symbol));
    for (const v of withVol) {
      if (!existing.has(v.symbol))
        monitoredPairs.push({ symbol: v.symbol, price: v.price, change: v.change * 100, lastSignal: null, lastCandle: {} });
    }
  } else {
    activeSymbols = [...contractSet].slice(0, MAX_PAIRS);
  }

  lastPairRefresh = Date.now();
  const posSymbols = new Set(positions.filter(p => p.status === 'open').map(p => p.symbol));
  const activeSet = new Set(activeSymbols);

  for (const s of activeSymbols) {
    if (!monitoredPairs.find(m => m.symbol === s))
      monitoredPairs.push({ symbol: s, price: 0, change: 0, lastSignal: null, lastCandle: {} });
  }
  monitoredPairs = monitoredPairs.filter(p => activeSet.has(p.symbol) || posSymbols.has(p.symbol));

  for (const key of Object.keys(processedCandles)) {
    const sym = key.split(':')[0];
    if (!activeSet.has(sym) && !posSymbols.has(sym)) delete processedCandles[key];
  }
  logFn('📋 ' + activeSymbols.length + ' high-volatility pairs');
}

// ── Tick Cache ──
let tickerCache = [];
let tickerCacheTime = 0;

async function getTicker(symbol) {
  if (Date.now() - tickerCacheTime > 5000) {
    const d = await publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    tickerCache = Array.isArray(d) ? d : [];
    tickerCacheTime = Date.now();
  }
  return tickerCache.find(t => t.symbol === symbol) || null;
}

// ── Scan ──
let lastScan = {};

async function scan() {
  await refreshPairs();
  if (activeSymbols.length === 0) return;
  const now = Date.now();

  for (const tf of TIMEFRAMES) {
    if (now - (lastScan[tf.name] || 0) < tf.scanMs) continue;
    lastScan[tf.name] = now;

    for (let i = 0; i < activeSymbols.length; i += 5) {
      const chunk = activeSymbols.slice(i, i + 5);
      const results = await Promise.all(chunk.map(async (symbol) => {
        const candles = await getCandles(symbol, tf.granularity, 50);
        if (!Array.isArray(candles) || candles.length < 40) return null;
        candles.reverse();

        const signal = checkMacdSignal(candles);
        if (!signal) return null;

        const pair = monitoredPairs.find(m => m.symbol === symbol);
        if (pair && candles.length >= 2) {
          if (!pair.lastCandle) pair.lastCandle = {};
          const prev = candles[candles.length - 2];
          pair.lastCandle[tf.name] = {
            open: parseFloat(prev[1]) || 0, high: parseFloat(prev[2]) || 0,
            low: parseFloat(prev[3]) || 0, close: parseFloat(prev[4]) || 0,
          };
        }
        return { symbol, signal, pair };
      }));
      for (const r of results) {
        if (!r) continue;
        const ticker = await getTicker(r.symbol);
        r.signal.entryPrice = ticker ? parseFloat(ticker.lastPr || 0) : 0;
        if (r.pair) r.pair.lastSignal = r.signal.direction;
        processSignal(r.symbol, r.signal);
      }
    }
  }
}

// ── Backfill ──
let backfillDone = false;

async function backfillHistory() {
  if (backfillDone) return;
  backfillDone = true;
  if (activeSymbols.length === 0) return;

  logFn('📚 Backfilling MACD 1D signals for ' + activeSymbols.length + ' pairs...');
  let histTrades = 0;

  for (let i = 0; i < activeSymbols.length; i += 5) {
    const chunk = activeSymbols.slice(i, i + 5);
    const results = await Promise.all(chunk.map(async (symbol) => {
      let localTrades = 0;
      const raw = await getCandles(symbol, '1D', 60);
      if (!Array.isArray(raw) || raw.length < 40) return 0;
      raw.reverse();

      for (let j = 35; j < raw.length; j++) {
        const slice = raw.slice(0, j + 1);
        const signal = checkMacdSignal(slice);
        if (!signal) continue;

        const sc = signal.signalCandle;
        const ts = parseInt(sc[0]);
        const key = symbol + ':macd1d:' + ts;
        if (processedCandles[key]) continue;
        processedCandles[key] = true;

        const isBuy = signal.direction === 'BUY';
        const entry = parseFloat(sc[4]);
        if (!entry) continue;

        const sl = calcSL(sc, signal.direction, entry);
        if (isBuy && entry <= sl) continue;
        if (!isBuy && entry >= sl) continue;

        const margin = fl2(DEMO_BALANCE * CAPITAL_PCT);
        const size = fl2(margin * LEVERAGE);
        const entryFee = fl2(size * TAKER_FEE);

        // Find exit: check next 10 candles for SL hit, else close at candle + 5
        let exitPrice = null, exitReason = 'TP_TIME';
        const maxExit = Math.min(j + 5, raw.length - 1);
        for (let k = j + 1; k <= maxExit; k++) {
          const cLow = parseFloat(raw[k][3]), cHigh = parseFloat(raw[k][2]);
          if (isBuy && cLow <= sl) { exitPrice = sl; exitReason = 'SL'; break; }
          if (!isBuy && cHigh >= sl) { exitPrice = sl; exitReason = 'SL'; break; }
        }
        if (!exitPrice && maxExit < raw.length) exitPrice = parseFloat(raw[maxExit][4]);

        if (!exitPrice) continue;

        const diff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
        const tradingPnl = (diff / entry) * size;
        const exitFee = fl2(size * TAKER_FEE);
        const netPnl = fl2(tradingPnl - exitFee - entryFee);

        totalFees = fl4(totalFees + entryFee + exitFee);
        totalRealizedPnl = fl4(totalRealizedPnl + netPnl);
        if (netPnl >= 0) wins++; else losses++;

        trades.push({
          symbol, direction: signal.direction,
          entryPrice: entry, sl, exitPrice, pnl: netPnl,
          margin, size, entryFee, timeframe: '1D',
          exitReason, time: ts, closeTime: Date.now(),
        });
        localTrades++;
      }
      return localTrades;
    }));
    for (const t of results) if (typeof t === 'number') histTrades += t;
    if (histTrades > 0) { saveState(); try { emitFn('snapshot', buildSnapshot()); } catch(_) {} }
  }

  if (trades.length > 500) trades = trades.slice(-500);
  balance = fl2(balance);
  logFn('📚 Backfill: ' + histTrades + ' MACD trades | Bal: $' + fl2(balance));
  saveState();
}

// ── State ──
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      stateVersion: STATE_VERSION, balance, lockedMargin, totalRealizedPnl, totalFees, wins, losses,
      trades: trades.slice(-300), positions: positions.filter(p => p.status === 'open'),
      signalLog: signalLog.slice(-200), processedCandles,
    }, null, 2));
  } catch (_) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (d.stateVersion === STATE_VERSION) {
        balance = d.balance || DEMO_BALANCE; lockedMargin = d.lockedMargin || 0;
        totalRealizedPnl = d.totalRealizedPnl || 0; totalFees = d.totalFees || 0;
        wins = d.wins || 0; losses = d.losses || 0;
        trades = d.trades || []; positions = (d.positions || []).filter(p => p.status === 'open');
        signalLog = d.signalLog || []; processedCandles = d.processedCandles || {};
        const openFees = positions.reduce((s, p) => s + (p.entryFee || 0), 0);
        const expected = DEMO_BALANCE + totalRealizedPnl - openFees;
        if (Math.abs(balance - expected) > 100) { console.log('⚠️ Balance correction: $' + balance + ' -> $' + expected); balance = expected; }
      } else { balance = DEMO_BALANCE; }
    }
  } catch (_) {}
}

// ── Snapshot ──
function buildSnapshot() {
  const openUpl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const totalMargin = positions.reduce((s, p) => s + (p.margin || 0), 0);
  const totalEquity = fl2(balance + openUpl);
  return {
    balance: totalEquity, available: fl2(totalEquity - totalMargin), locked: fl2(totalMargin),
    totalPnl: fl4(totalRealizedPnl + openUpl), totalFees: fl4(totalFees),
    wins, losses, totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4((wins / (wins + losses)) * 100) : 0,
    positions: positions.filter(p => p.status === 'open').map(p => ({
      symbol: p.symbol, direction: p.direction, entryPrice: p.entryPrice,
      slPrice: p.slPrice, markPrice: p.markPrice || 0,
      size: p.size, margin: p.margin, timeframe: p.timeframe,
      unrealizedPnl: p.unrealizedPnl || 0,
      trailingStop: p.trailingStop,
    })),
    pairs: monitoredPairs.map(p => ({ symbol: p.symbol, price: p.price, change: p.change, lastCandle: p.lastCandle || {}, lastSignal: p.lastSignal })),
    signals: signalLog.slice(-40).reverse(),
    trades: trades.slice(-40).reverse().map(t => ({
      symbol: t.symbol, direction: t.direction, entryPrice: t.entryPrice,
      exitPrice: t.exitPrice || 0, pnl: t.pnl, margin: t.margin,
      timeframe: t.timeframe, exitReason: t.exitReason, time: t.time, closeTime: t.closeTime,
    })),
    timeframes: TIMEFRAMES.map(t => t.name),
    demo: true, strategy: 'MACD 1D ' + MAX_PAIRS + 'p',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activePairs: positions.filter(p => p.status === 'open').length,
  };
}

// ── Tick ──
async function tick() {
  try { await scan(); await updatePositions(); emitFn('snapshot', buildSnapshot()); }
  catch (e) { logFn('⚠️ Tick: ' + e.message); }
}

// ── Start ──
async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  loadState();
  logFn('✅ MACD Bot v' + STATE_VERSION + ' | ' + MAX_PAIRS + ' pairs 1D | ' + (CAPITAL_PCT*100) + '% x' + LEVERAGE + ' | DEMO $' + fl2(balance));
  emitFn('snapshot', buildSnapshot());
  await refreshPairs();
  await backfillHistory();
  setTimeout(tick, 5000);
  setInterval(tick, 60000);
  setInterval(async () => {
    try {
      for (const p of monitoredPairs) { const t = tickerCache.find(tc => tc.symbol === p.symbol); if (t) p.price = parseFloat(t.lastPr || t.markPrice || 0) || p.price; }
      await updatePositions();
      emitFn('snapshot', buildSnapshot());
    } catch(e) {}
  }, 5000);
  emitFn('snapshot', buildSnapshot());
}

// ── Backtest ──
async function runBacktest(opts = {}) {
  const topPairs = opts.topPairs || 5;
  const results = { overall: { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, winRate: 0, roi: 0 }, timeframe: {} };

  const [contracts, tickers] = await Promise.all([
    publicGet('/api/v2/mix/market/contracts?productType=USDT-FUTURES'),
    publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES')
  ]);
  if (!Array.isArray(contracts)) return { error: 'Failed' };

  const contractSet = new Set(contracts.filter(c => c.symbol.endsWith('USDT') && c.symbolStatus === 'normal').map(c => c.symbol));
  let symbols = [];
  if (Array.isArray(tickers)) {
    const withVol = tickers.filter(t => contractSet.has(t.symbol))
      .map(t => ({ symbol: t.symbol, volPct: (parseFloat(t.high24h||0)-parseFloat(t.low24h||0))/(parseFloat(t.low24h||1))*100, volume: parseFloat(t.usdtVolume||0) }))
      .filter(t => t.volume > 500000 && t.volPct > 0);
    withVol.sort((a, b) => b.volPct - a.volPct);
    symbols = withVol.slice(0, topPairs).map(t => t.symbol);
  } else { symbols = [...contractSet].slice(0, topPairs); }

  for (const symbol of [...new Set(symbols)]) {
    for (const tf of TIMEFRAMES) {
      const tfKey = tf.name;
      if (!results.timeframe[tfKey]) results.timeframe[tfKey] = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0 };
      const raw = await getCandles(symbol, tf.granularity, 60);
      if (!raw || raw.length < 40) continue;
      raw.reverse();

      let btBalance = DEMO_BALANCE;
      for (let j = 35; j < raw.length; j++) {
        const slice = raw.slice(0, j + 1);
        const signal = checkMacdSignal(slice);
        if (!signal) continue;

        const sc = signal.signalCandle;
        const isBuy = signal.direction === 'BUY';
        const entry = parseFloat(sc[4]);
        if (!entry) continue;
        const sl = calcSL(sc, signal.direction, entry);
        if (isBuy && entry <= sl) continue;
        if (!isBuy && entry >= sl) continue;

        const margin = fl2(btBalance * CAPITAL_PCT);
        if (btBalance < margin * 0.5) continue;
        const size = fl2(margin * LEVERAGE);
        const entryFee = fl2(size * TAKER_FEE);
        btBalance = fl2(btBalance - entryFee);

        let exitPrice = null, exitReason = 'TP_TIME';
        const maxExit = Math.min(j + 5, raw.length - 1);
        for (let k = j + 1; k <= maxExit; k++) {
          const cLow = parseFloat(raw[k][3]), cHigh = parseFloat(raw[k][2]);
          if (isBuy && cLow <= sl) { exitPrice = sl; exitReason = 'SL'; break; }
          if (!isBuy && cHigh >= sl) { exitPrice = sl; exitReason = 'SL'; break; }
        }
        if (!exitPrice && maxExit < raw.length) exitPrice = parseFloat(raw[maxExit][4]);
        if (!exitPrice) continue;

        const diff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
        const tradingPnl = (diff / entry) * size;
        const exitFee = fl2(size * TAKER_FEE);
        const netPnl = fl2(tradingPnl - exitFee - entryFee);
        btBalance = fl2(btBalance + tradingPnl - exitFee);

        const tfResult = results.timeframe[tfKey];
        tfResult.trades++; tfResult.pnl = fl4(tfResult.pnl + netPnl);
        tfResult.fees = fl4(tfResult.fees + entryFee + exitFee);
        if (netPnl >= 0) tfResult.wins++; else tfResult.losses++;
      }
    }
  }

  const o = results.overall;
  for (const tfKey of Object.keys(results.timeframe)) {
    const tf = results.timeframe[tfKey];
    o.trades += tf.trades; o.wins += tf.wins; o.losses += tf.losses;
    o.pnl = fl4(o.pnl + tf.pnl); o.fees = fl4(o.fees + tf.fees);
  }
  results.overall.winRate = results.overall.trades > 0 ? fl4((results.overall.wins / results.overall.trades) * 100) : 0;
  results.overall.roi = fl4((results.overall.pnl / DEMO_BALANCE) * 100);
  return results;
}

module.exports = { start, buildSnapshot, runBacktest };
