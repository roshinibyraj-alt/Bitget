'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──
const API_BASE = 'https://api.bitget.com';
const DEMO_BALANCE = 30000;
const CAPITAL_PCT = 0.01;
const LEVERAGE = 20;
const TAKER_FEE = 0.0006;

const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 8;
const MAX_VOLATILE_PAIRS = 40; // top volatile pairs to monitor

const TIMEFRAMES = [
  { name: '1D', granularity: '1D', scanMs: 86400000 },
];

// ── Daily Refresh Schedule (15:50 UTC) ──
function getMsUntilNextRefresh() {
  const now = Date.now();
  const d = new Date(now);
  d.setUTCHours(15, 50, 0, 0);
  let target = d.getTime();
  if (target <= now) target += 86400000;
  return target - now;
}

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

// ── API ──
async function publicGet(path) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(API_BASE + path, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.code !== '00000') return null;
    return data.data;
  } catch (_) { return null; }
}

async function getAllTickers() {
  return await publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
}

async function getCandles(symbol, granularity, limit) {
  return await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=${limit || 10}`);
}

async function fetchContracts() {
  return await publicGet('/api/v2/mix/market/contracts?productType=USDT-FUTURES');
}

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

// ── Pair Selection (daily refresh at 15:50 UTC) ──
let lastPairRefresh = 0;
let activeSymbols = [];

async function refreshPairs() {
  const isFirstRun = lastPairRefresh === 0;
  // Don't refresh more than once per minute (avoids spamming API)
  if (!isFirstRun && Date.now() - lastPairRefresh < 60000) return;

  // Fetch contracts (for status validation) and tickers (for volatility)
  const [contracts, tickers] = await Promise.all([
    fetchContracts(),
    publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES')
  ]);
  if (!Array.isArray(contracts)) return;
  
  const contractSet = new Set(
    contracts.filter(c => c.symbol.endsWith('USDT') && c.symbolStatus === 'normal').map(c => c.symbol)
  );
  
  if (!Array.isArray(tickers)) {
    // Fallback: use contracts list without volatility filter
    activeSymbols = [...contractSet].slice(0, MAX_VOLATILE_PAIRS);
  } else {
    // Calculate 24h volatility range % for each pair
    const withVol = tickers
      .filter(t => contractSet.has(t.symbol)) // only active contracts
      .map(t => {
        const high = parseFloat(t.high24h || 0);
        const low = parseFloat(t.low24h || 0);
        const volume = parseFloat(t.usdtVolume || 0);
        const volPct = low > 0 ? ((high - low) / low) * 100 : 0;
        return { symbol: t.symbol, volPct, volume, price: parseFloat(t.lastPr || 0), change: parseFloat(t.change24h || 0) };
      })
      .filter(t => t.volume > 100000 && t.volPct > 0); // minimum $100k volume
    
    // Sort by volatility descending, pick top MAX_VOLATILE_PAIRS
    withVol.sort((a, b) => b.volPct - a.volPct);
    activeSymbols = withVol.slice(0, MAX_VOLATILE_PAIRS).map(t => t.symbol);
    
    // Pre-populate price and change for monitoredPairs
    const volMap = new Map(withVol.map(t => [t.symbol, t]));
    for (const v of withVol) {
      if (!monitoredPairs.find(m => m.symbol === v.symbol)) {
        monitoredPairs.push({ symbol: v.symbol, price: v.price, change: v.change * 100, lastSignal: null, lastCandle: {} });
      }
    }
  }
  
  lastPairRefresh = Date.now();

  // Keep pairs with open positions
  const posSymbols = new Set(positions.filter(p => p.status === 'open').map(p => p.symbol));
  const activeSet = new Set(activeSymbols);

  // Add new pairs (if not already added by volMap loop above)
  for (const s of activeSymbols) {
    if (!monitoredPairs.find(m => m.symbol === s)) {
      monitoredPairs.push({ symbol: s, price: 0, change: 0, lastSignal: null, lastCandle: {} });
    }
  }
  // Remove pairs no longer in active set (unless they have open positions)
  monitoredPairs = monitoredPairs.filter(p => activeSet.has(p.symbol) || posSymbols.has(p.symbol));

  // Keep processedCandles for active pairs
  for (const key of Object.keys(processedCandles)) {
    const sym = key.split(':')[0];
    if (!activeSet.has(sym) && !posSymbols.has(sym)) delete processedCandles[key];
  }

  logFn('📋 ' + activeSymbols.length + ' high-volatility pairs monitored (top ' + MAX_VOLATILE_PAIRS + ')');
}

// ── Candle Color Signal: 3+ consecutive → reversal ──
function checkCandleSignal(candles) {
  if (!Array.isArray(candles) || candles.length < 4) return null;
  // candles[0] oldest, candles[last-1] = signal candle (closed), candles[last] = forming
  const signalCandle = candles[candles.length - 2]; // last closed candle
  if (!signalCandle) return null;
  const sigOpen = parseFloat(signalCandle[1]);
  const sigClose = parseFloat(signalCandle[4]);
  const sigHigh = parseFloat(signalCandle[2]);
  const sigLow = parseFloat(signalCandle[3]);
  const sigTs = signalCandle[0];
  if (!sigOpen || !sigClose) return null;
  const sigGreen = sigClose > sigOpen;
  const sigRed = sigClose < sigOpen;
  if (!sigGreen && !sigRed) return null;

  // Count consecutive candles BEFORE signalCandle that are opposite color
  const needColor = sigGreen ? 'RED' : 'GREEN'; // we need 3+ consecutive BEFORE in the opposite direction
  let consecutive = 0;
  for (let i = candles.length - 3; i >= 0; i--) {
    const c = candles[i];
    const co = parseFloat(c[1]);
    const cc = parseFloat(c[4]);
    if (!co || !cc) break;
    if (needColor === 'GREEN' && cc > co) { consecutive++; }
    else if (needColor === 'RED' && cc < co) { consecutive++; }
    else break;
  }

  if (consecutive < 3) return null; // need 3+ consecutive in opposite direction

  // signal is a reversal: after 3+ GREEN consecutive, now RED → SHORT
  // After 3+ RED consecutive, now GREEN → LONG
  const direction = sigRed ? 'SELL' : 'BUY';
  return {
    direction: direction,
    signalTime: parseInt(sigTs),
    candleOpen: sigOpen, candleClose: sigClose, candleHigh: sigHigh, candleLow: sigLow,
    isGreen: sigGreen, consecutiveCount: consecutive,
  };
}

// ── Process Signal (live) ──
function processSignal(symbol, signal, tf, price) {
  const key = `${symbol}:${tf.name}:${signal.signalTime}`;
  if (processedCandles[key]) return;
  processedCandles[key] = true;

  const isBuy = signal.direction === 'BUY';
  const entry = price;
  const sl = isBuy ? signal.candleLow : signal.candleHigh;
  const margin = fl2(DEMO_BALANCE * CAPITAL_PCT);

  const currentOpenUpl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  if (balance + currentOpenUpl - lockedMargin < margin) return;

  const size = fl2(margin * LEVERAGE);
  const contracts = fl2(size / entry);
  if (contracts <= 0) return;

  const entryFee = fl2(size * TAKER_FEE);
  totalFees = fl4(totalFees + entryFee);
  balance = fl2(balance - entryFee);

  // TP: 2 candle durations from signal candle end
  const CANDLE_MS = 86400000;
  const signalEndMs = signal.signalTime + CANDLE_MS;
  const tpTime = signalEndMs + CANDLE_MS * 2;

  if (isBuy && entry <= sl) return;
  if (!isBuy && entry >= sl) return;

  const pos = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    symbol, side: isBuy ? 'open_long' : 'open_short', direction: signal.direction,
    entryPrice: entry, slPrice: sl, tpPrice: null,
    signalCandleLow: signal.candleLow, signalCandleHigh: signal.candleHigh,
    signalCandleOpen: signal.candleOpen, signalCandleClose: signal.candleClose,
    size, margin, contracts, timeframe: tf.name,
    entryFee, time: Date.now(), tpTime,
    status: 'open', unrealizedPnl: 0, markPrice: entry,
  };
  lockedMargin = fl2(lockedMargin + margin);
  positions.push(pos);

  const pair = monitoredPairs.find(p => p.symbol === symbol);
  if (pair) {
    pair.lastSignal = signal.direction;
    if (!pair.lastCandle) pair.lastCandle = {};
    pair.lastCandle[tf.name] = { open: signal.candleOpen, high: signal.candleHigh, low: signal.candleLow, close: signal.candleClose };
  }

  signalLog.push({
    symbol, side: pos.side, entryPrice: entry, slPrice: sl,
    candleOpen: signal.candleOpen, candleClose: signal.candleClose,
    timeframe: tf.name, direction: signal.direction, time: Date.now(),
  });
  if (signalLog.length > 200) signalLog = signalLog.slice(-200);

  logFn(`📊 ${signal.direction} ${symbol} (${tf.name}) | ${signal.consecutiveCount} consecutive → reversal | Entry: $${entry} | SL: $${sl}`);
  saveState();
  emitFn('snapshot', buildSnapshot());
}

// ── Backfill 10 Days of 1D History ──
let backfillDone = false;

async function backfillHistory() {
  if (backfillDone) return;
  backfillDone = true;
  if (activeSymbols.length === 0) return;

  logFn(`📚 Backfilling 10 days of 1D reversal signals for ${activeSymbols.length} pairs...`);
  let histTrades = 0;

  // Process pairs concurrently in batches of 10
  const batchSize = 10;
  for (let batchStart = 0; batchStart < activeSymbols.length; batchStart += batchSize) {
    const batch = activeSymbols.slice(batchStart, batchStart + batchSize);
    const batchResults = await Promise.all(batch.map(async (symbol) => {
      let localTrades = 0;
      const candles = await getCandles(symbol, '1D', 15);
      if (!Array.isArray(candles) || candles.length < 7) return 0;
      
      for (let i = 4; i < candles.length - 1; i++) {
        const slice = candles.slice(0, i + 1);
        const signal = checkCandleSignal(slice);
        if (!signal) continue;

        const key = symbol + ':1D:' + signal.signalTime;
        if (processedCandles[key]) continue;
        processedCandles[key] = true;

        const entryCandle = candles[i];
        const entry = parseFloat(entryCandle[1]);
        if (!entry) continue;

        const isBuy = signal.direction === 'BUY';
        const sl = isBuy ? signal.candleLow : signal.candleHigh;
        if (isBuy && entry <= sl) continue;
        if (!isBuy && entry >= sl) continue;

        const margin = fl2(DEMO_BALANCE * CAPITAL_PCT);
        const size = fl2(margin * LEVERAGE);
        const entryFee = fl2(size * TAKER_FEE);

        const exitIdx = Math.min(i + 2, candles.length - 1);
        let exitPrice = null, exitReason = 'TP_TIME';
        for (let j = i + 1; j <= exitIdx && j < candles.length; j++) {
          const cLow = parseFloat(candles[j][3]);
          const cHigh = parseFloat(candles[j][2]);
          if (isBuy && cLow <= sl) { exitPrice = sl; exitReason = 'SL'; break; }
          if (!isBuy && cHigh >= sl) { exitPrice = sl; exitReason = 'SL'; break; }
        }
        if (!exitPrice) exitPrice = parseFloat(candles[exitIdx][4]);

        const diff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
        const tradingPnl = (diff / entry) * size;
        const exitFee = fl2(size * TAKER_FEE);
        const netPnl = fl2(tradingPnl - exitFee - entryFee);

        totalFees = fl4(totalFees + entryFee + exitFee);
        totalRealizedPnl = fl4(totalRealizedPnl + netPnl);
        if (netPnl >= 0) wins++; else losses++;

        trades.push({
          symbol: symbol, direction: signal.direction,
          entryPrice: entry, slPrice: sl, exitPrice: exitPrice, pnl: netPnl,
          margin: margin, size: size, entryFee: entryFee, timeframe: '1D',
          exitReason: exitReason,
          signalCandleOpen: signal.candleOpen, signalCandleClose: signal.candleClose,
          consecutive: signal.consecutiveCount,
          time: parseInt(entryCandle[0]),
          closeTime: parseInt(candles[exitIdx][0]) + 86400000,
        });
        localTrades++;
      }
      return localTrades;
    }));
    
    // Sum up trades from this batch
    for (const t of batchResults) {
      if (typeof t === 'number') histTrades += t;
    }
    
    // Periodically save state and emit updates during long backfill
    if (histTrades > 0) {
      saveState();
      try { emitFn('snapshot', buildSnapshot()); } catch(_) {}
    }
  }

  if (trades.length > 500) trades = trades.slice(-500);
  balance = fl2(balance);
  logFn('📚 Backfill: ' + histTrades + ' historical trades | Bal: $' + fl2(balance));
  saveState();
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

    let closed = false, pnl = 0, reason = '';

    if (isLong && price <= pos.slPrice) {
      pnl = fl2(((pos.slPrice - pos.entryPrice) / pos.entryPrice) * pos.size);
      reason = 'SL'; closed = true;
    } else if (!isLong && price >= pos.slPrice) {
      pnl = fl2(((pos.entryPrice - pos.slPrice) / pos.entryPrice) * pos.size);
      reason = 'SL'; closed = true;
    }

    if (!closed && Date.now() >= pos.tpTime) {
      const exitPnl = (diff / pos.entryPrice) * pos.size;
      pnl = fl2(exitPnl); reason = 'TP_TIME'; closed = true;
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
      const emoji = reason === 'SL' ? '🔴' : '🟢';
      logFn(`${emoji} ${reason} ${pos.symbol} (${pos.timeframe}) | Entry:$${pos.entryPrice} Exit:$${price} | PnL:$${fl2(pos.pnl)}`);
      saveState();
      emitFn('snapshot', buildSnapshot());
    }
  }
}

// ── Scan 1D Signals ──
let lastScan = {};

async function scan() {
  await refreshPairs();
  if (activeSymbols.length === 0) return;

  const now = Date.now();

  for (const tf of TIMEFRAMES) {
    if (now - (lastScan[tf.name] || 0) < tf.scanMs) continue;
    lastScan[tf.name] = now;

    const symbols = [...activeSymbols];
    const results = [];
    for (let i = 0; i < symbols.length; i += 5) {
      const chunk = symbols.slice(i, i + 5);
      const chunkResults = await Promise.all(chunk.map(async (symbol) => {
        const candles = await getCandles(symbol, tf.granularity, 15);
        if (!Array.isArray(candles) || candles.length < 5) return null;

        const prev = candles[candles.length - 2];
        const prevEndTs = parseInt(prev[0]);
        const CANDLE_MS = 86400000;
        const candleEndTime = prevEndTs + CANDLE_MS;

        if (now < candleEndTime) return null;
        if (now - candleEndTime > CANDLE_MS * 1.5) return null; // too old for live

        const signal = checkCandleSignal(candles);
        if (!signal) return null;

        const pair = monitoredPairs.find(m => m.symbol === symbol);
        if (pair && candles.length >= 2) {
          if (!pair.lastCandle) pair.lastCandle = {};
          pair.lastCandle[tf.name] = {
            open: parseFloat(prev[1]) || 0,
            high: parseFloat(prev[2]) || 0,
            low: parseFloat(prev[3]) || 0,
            close: parseFloat(prev[4]) || 0,
          };
        }
        return { symbol, signal, tf, pair };
      }));
      results.push(...chunkResults);
    }
    for (const r of results) {
      if (!r) continue;
      const { symbol, signal, tf, pair } = r;
      const ticker = await getTicker(symbol);
      const price = ticker ? parseFloat(ticker.lastPr || 0) : 0;
      if (!price) continue;
      if (pair) pair.lastSignal = signal.direction;
      processSignal(symbol, signal, tf, price);
    }
  }
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
        balance = d.balance || DEMO_BALANCE;
        lockedMargin = d.lockedMargin || 0;
        totalRealizedPnl = d.totalRealizedPnl || 0;
        totalFees = d.totalFees || 0;
        wins = d.wins || 0; losses = d.losses || 0;
        trades = d.trades || [];
        positions = (d.positions || []).filter(p => p.status === 'open');
        signalLog = d.signalLog || [];
        processedCandles = d.processedCandles || {};
      } else { balance = DEMO_BALANCE; }
    }
  } catch (_) {}
}

// ── Snapshot ──
function buildSnapshot() {
  const openUpl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const totalMargin = positions.reduce((s, p) => s + (p.margin || 0), 0);
  const totalEquity = fl2(balance + openUpl);
  const availableBalance = fl2(totalEquity - totalMargin);
  return {
    balance: totalEquity,
    available: availableBalance,
    locked: fl2(totalMargin),
    totalPnl: fl4(totalRealizedPnl + openUpl),
    realizedPnl: fl4(totalRealizedPnl),
    unrealizedPnl: fl4(openUpl),
    totalFees: fl4(totalFees),
    wins, losses,
    totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4((wins / (wins + losses)) * 100) : 0,
    positions: positions.filter(p => p.status === 'open').map(p => ({
      symbol: p.symbol, side: p.side, direction: p.direction,
      entryPrice: p.entryPrice, slPrice: p.slPrice,
      signalCandleOpen: p.signalCandleOpen, signalCandleClose: p.signalCandleClose,
      size: p.size, margin: p.margin, contracts: p.contracts,
      timeframe: p.timeframe, unrealizedPnl: p.unrealizedPnl || 0,
      markPrice: p.markPrice || 0, entryFee: p.entryFee || 0,
      tpTime: p.tpTime,
    })),
    pairs: monitoredPairs.map(p => ({
      change: p.change || 0,
      symbol: p.symbol, price: p.price,
      lastCandle: p.lastCandle || {},
      lastSignal: p.lastSignal,
    })),
    signals: signalLog.slice(-40).reverse(),
    trades: trades.slice(-40).reverse().map(t => ({
      symbol: t.symbol, side: t.side, direction: t.direction,
      entryPrice: t.entryPrice, slPrice: t.slPrice,
      exitPrice: t.exitPrice || 0,
      signalCandleOpen: t.signalCandleOpen, signalCandleClose: t.signalCandleClose,
      pnl: t.pnl, margin: t.margin, timeframe: t.timeframe,
      exitReason: t.exitReason, entryFee: t.entryFee,
      time: t.time, closeTime: t.closeTime,
    })),
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
    await updatePositions();
    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    logFn(`⚠️ Tick: ${e.message}`);
  }
}

// ── Start ──
async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  loadState();
  logFn(`✅ Reversal Bot v${STATE_VERSION} | DEMO $${fl2(balance)} | 1D only`);
  logFn(`📊 3+ consecutive → reversal | SL: candle low/high | TP: 2 days after entry`);

  // Initial pair fetch (synchronous)
  await refreshPairs();
  // Initial emit so dashboard has data immediately
  emitFn('snapshot', buildSnapshot());

  // Run backfill in background - don't block startup
  backfillHistory().catch(e => logFn('⚠️ Backfill error: ' + e.message));

  // Schedule daily pair refresh at 15:50 UTC
  const msUntilRefresh = getMsUntilNextRefresh();
  logFn('📅 Next pair refresh in ' + Math.round(msUntilRefresh / 60000) + ' min');
  setTimeout(async function refreshLoop() {
    await refreshPairs();
    emitFn('snapshot', buildSnapshot());
    setTimeout(refreshLoop, getMsUntilNextRefresh());
  }, msUntilRefresh);

  // Live trading loop
  setTimeout(tick, 5000);
  setInterval(tick, 60000);

  // Fast price update for dashboard
  setInterval(async () => {
    try {
      for (const p of monitoredPairs) {
        const t = tickerCache.find(tc => tc.symbol === p.symbol);
        if (t) p.price = parseFloat(t.lastPr || t.markPrice || 0) || p.price;
      }
      await updatePositions();
      emitFn('snapshot', buildSnapshot());
    } catch(e) {}
  }, 5000);

  emitFn('snapshot', buildSnapshot());
}

// ── Backtest (kept for dashboard) ──
async function fetchAllCandles(symbol, granularity) {
  const data = await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=200`);
  if (!Array.isArray(data)) return [];
  // Return oldest first
  return data.reverse();
}

async function runBacktest(opts = {}) {
  const topPairs = opts.topPairs || 5;
  const daysBack = 30;
  const results = { overall: { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, winRate: 0, roi: 0 }, timeframe: {} };

  const [contracts, tickers] = await Promise.all([
    fetchContracts(),
    publicGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES')
  ]);
  if (!Array.isArray(contracts)) return { error: 'Failed to fetch contracts' };
  
  const contractSet = new Set(
    contracts.filter(c => c.symbol.endsWith('USDT') && c.symbolStatus === 'normal').map(c => c.symbol)
  );
  
  let symbols = [];
  if (Array.isArray(tickers)) {
    const withVol = tickers
      .filter(t => contractSet.has(t.symbol))
      .map(t => {
        const high = parseFloat(t.high24h || 0);
        const low = parseFloat(t.low24h || 0);
        const volume = parseFloat(t.usdtVolume || 0);
        const volPct = low > 0 ? ((high - low) / low) * 100 : 0;
        return { symbol: t.symbol, volPct, volume };
      })
      .filter(t => t.volume > 100000 && t.volPct > 0);
    withVol.sort((a, b) => b.volPct - a.volPct);
    symbols = withVol.slice(0, topPairs).map(t => t.symbol);
  } else {
    symbols = [...contractSet].slice(0, topPairs);
  }

  for (const symbol of [...new Set(symbols)]) {
    for (const tf of TIMEFRAMES) {
      const tfKey = tf.name;
      if (!results.timeframe[tfKey]) results.timeframe[tfKey] = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0 };

      const candles = await fetchAllCandles(symbol, tf.granularity);
      if (candles.length < 5) continue;

      let btBalance = DEMO_BALANCE;
      for (let i = 4; i < candles.length; i++) {
        const slice = candles.slice(0, i + 1);
        const signal = checkCandleSignal(slice);
        if (!signal) continue;

        const isBuy = signal.direction === 'BUY';
        const entryCandle = candles[i];
        if (!entryCandle) continue;
        const entry = parseFloat(entryCandle[1]);
        if (!entry) continue;

        const sl = isBuy ? signal.candleLow : signal.candleHigh;
        const margin = fl2(DEMO_BALANCE * CAPITAL_PCT);
        if (btBalance < margin) continue;
        const size = fl2(margin * LEVERAGE);
        const entryFee = fl2(size * TAKER_FEE);
        btBalance = fl2(btBalance - entryFee);

        const exitIdx = Math.min(i + 2, candles.length - 1);
        let exitPrice = null, exitReason = 'TP_TIME';
        for (let j = i + 1; j <= exitIdx && j < candles.length; j++) {
          const cLow = parseFloat(candles[j][3]);
          const cHigh = parseFloat(candles[j][2]);
          if (isBuy && cLow <= sl) { exitPrice = sl; exitReason = 'SL'; break; }
          if (!isBuy && cHigh >= sl) { exitPrice = sl; exitReason = 'SL'; break; }
        }
        if (!exitPrice) exitPrice = parseFloat(candles[exitIdx][4]);

        const diff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
        const tradingPnl = (diff / entry) * size;
        const exitFee = fl2(size * TAKER_FEE);
        const netPnl = fl2(tradingPnl - exitFee - entryFee);
        btBalance = fl2(btBalance + tradingPnl - exitFee);

        const tfResult = results.timeframe[tfKey];
        tfResult.trades++;
        tfResult.pnl = fl4(tfResult.pnl + netPnl);
        tfResult.fees = fl4(tfResult.fees + entryFee + exitFee);
        if (netPnl >= 0) tfResult.wins++; else tfResult.losses++;
      }
    }
  }

  const o = results.overall;
  for (const tfKey of Object.keys(results.timeframe)) {
    const tf = results.timeframe[tfKey];
    o.trades += tf.trades;
    o.wins += tf.wins;
    o.losses += tf.losses;
    o.pnl = fl4(o.pnl + tf.pnl);
    o.fees = fl4(o.fees + tf.fees);
  }
  results.overall.winRate = results.overall.trades > 0 ? fl4((results.overall.wins / results.overall.trades) * 100) : 0;
  results.overall.roi = fl4((results.overall.pnl / DEMO_BALANCE) * 100);
  return results;
}

module.exports = { start, buildSnapshot, runBacktest };
