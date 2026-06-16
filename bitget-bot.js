'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──
const API_BASE = 'https://api.bitget.com';
const DEMO_BALANCE = 30000;
const CAPITAL_PCT = 0.01;
const LEVERAGE = 20;
const TAKER_FEE = 0.0006;
const TOP_PAIRS = 10;
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 6;
const MIN_VOLUME = 100000;

const TIMEFRAMES = [
  { name: '15m', granularity: '15m', scanMs: 900000   },
  { name: '1H',  granularity: '1H',  scanMs: 3600000   },
  { name: '4H',  granularity: '4H',  scanMs: 14400000  },
  { name: '1D',  granularity: '1D',  scanMs: 86400000  },
];

// ── State ──
let balance = DEMO_BALANCE;
let lockedMargin = 0; // margin locked in open positions
let totalFees = 0;
let totalRealizedPnl = 0;
let wins = 0;
let losses = 0;
let trades = [];
let positions = [];
let monitoredPairs = [];
let signalLog = [];
let processedCandles = {}; // key: symbol:tf:ts -> true
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

async function getCandles(symbol, granularity) {
  return await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=10`);
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

// ── Pair Selection ──
let lastPairRefresh = 0;
let activeSymbols = [];

async function refreshTopPairs() {
  if (Date.now() - lastPairRefresh < 300000 && activeSymbols.length > 0) return;
  const tickers = await getAllTickers();
  if (!Array.isArray(tickers)) return;
  const usdt = tickers.filter(t => t.symbol.endsWith('USDT') && parseFloat(t.usdtVolume || 0) >= MIN_VOLUME);
  const withChange = usdt.map(t => {
    const last = parseFloat(t.lastPr || 0);
    const open = parseFloat(t.open24h || 0);
    const chg = open > 0 ? ((last - open) / open) * 100 : 0;
    return { symbol: t.symbol, change: chg, price: last };
  }).filter(t => t.price > 0);
  withChange.sort((a, b) => b.change - a.change);
  const gainers = withChange.slice(0, TOP_PAIRS);
  const losers = withChange.slice(-TOP_PAIRS).reverse();
  activeSymbols = [...new Set([...gainers.map(t => t.symbol), ...losers.map(t => t.symbol)])];
  lastPairRefresh = Date.now();

  // Remove pairs no longer in top 20 AND with no open positions
  const posSymbols = new Set(positions.filter(p => p.status === 'open').map(p => p.symbol));
  monitoredPairs = monitoredPairs.filter(p => activeSymbols.includes(p.symbol) || posSymbols.has(p.symbol));
  // Clean up processedCandles for removed pairs to prevent unbounded growth
  const activeSet = new Set(activeSymbols);
  for (const key of Object.keys(processedCandles)) {
    const sym = key.split(':')[0];
    if (!activeSet.has(sym) && !posSymbols.has(sym)) delete processedCandles[key];
  }

  // Init/update monitored pairs for current active symbols
  const pairMap = {};
  withChange.forEach(t => { pairMap[t.symbol] = { price: t.price, change: t.change }; });
  for (const s of activeSymbols) {
    const existing = monitoredPairs.find(m => m.symbol === s);
    const td = pairMap[s] || {};
    if (existing) {
      existing.price = td.price || existing.price;
      existing.change = td.change;
    } else {
      monitoredPairs.push({ symbol: s, price: td.price || 0, change: td.change || 0, lastSignal: null, lastCandle: {} });
    }
  }
  logFn(`📋 ${activeSymbols.length} pairs (${gainers[0]?.symbol}+${fl2(gainers[0]?.change)}% / ${losers[0]?.symbol}${fl2(losers[0]?.change)}%)`);
}

// ── Candle Color Signal ──
function checkCandleSignal(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;

  // candles[0] = oldest, candles[last] = newest (still forming)
  // candles[last-1] = previous completed candle
  const prev = candles[candles.length - 2]; // previous closed candle
  const prev2 = candles[candles.length - 3]; // candle before that (for reference)

  if (!prev) return null;

  const open = parseFloat(prev[1]);
  const close = parseFloat(prev[4]);
  const high = parseFloat(prev[2]);
  const low = parseFloat(prev[3]);
  const ts = prev[0]; // candle timestamp

  if (!open || !close) return null;

  const isGreen = close > open;
  const isRed = close < open;
  if (!isGreen && !isRed) return null; // doji, skip

  return {
    direction: isGreen ? 'BUY' : 'SELL',
    signalTime: parseInt(ts),
    candleOpen: open,
    candleClose: close,
    candleHigh: high,
    candleLow: low,
    isGreen,
  };
}

// ── Process Signal ──
function processSignal(symbol, signal, tf, price) {
  const key = `${symbol}:${tf.name}:${signal.signalTime}`;
  if (processedCandles[key]) return;
  processedCandles[key] = true;

  const isBuy = signal.direction === 'BUY';
  const entry = price;
  const sl = isBuy ? signal.candleLow : signal.candleHigh;
  const margin = fl2(DEMO_BALANCE * CAPITAL_PCT);

  // Check available = total equity - locked margin (including unrealized PnL)
  const currentOpenUpl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  if (balance + currentOpenUpl - lockedMargin < margin) return;

  const size = fl2(margin * LEVERAGE);
  const contracts = fl2(size / entry);
  if (contracts <= 0) return;

  const entryFee = fl2(size * TAKER_FEE);
  totalFees = fl4(totalFees + entryFee);
  balance = fl2(balance - entryFee);

  // TP time: 2 candle durations from signal time
  const candleMs = tf.name === '15m' ? 900000 : (tf.name === '1H' ? 3600000 : (tf.name === '4H' ? 14400000 : 86400000));
  const tpTime = Date.now() + candleMs * 2; // exit after 2 candles

  // Skip if entry would immediately hit SL
  if (isBuy && entry <= sl) return;
  if (!isBuy && entry >= sl) return;

  const btcSide = isBuy ? 'open_long' : 'open_short';

  const pos = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    symbol, side: btcSide, direction: signal.direction,
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
    symbol, side: btcSide, entryPrice: entry, slPrice: sl, candleOpen: signal.candleOpen, candleClose: signal.candleClose,
    timeframe: tf.name, direction: signal.direction, time: Date.now(),
  });
  if (signalLog.length > 200) signalLog = signalLog.slice(-200);

  logFn(`📊 ${signal.direction} ${symbol} (${tf.name}) | Entry: $${entry} | SL: $${sl} | Candle: O$${signal.candleOpen} C$${signal.candleClose}`);
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

    let closed = false;
    let pnl = 0;
    let reason = '';

    // Check SL — loss = actual price move × position size
    if (isLong && price <= pos.slPrice) {
      pnl = fl2(((pos.slPrice - pos.entryPrice) / pos.entryPrice) * pos.size);
      reason = 'SL';
      closed = true;
    } else if (!isLong && price >= pos.slPrice) {
      pnl = fl2(((pos.entryPrice - pos.slPrice) / pos.entryPrice) * pos.size);
      reason = 'SL';
      closed = true;
    }

    // Check TP (time-based)
    if (!closed && Date.now() >= pos.tpTime) {
      // Exit at current price after 2 candles
      const exitPnl = (diff / pos.entryPrice) * pos.size;
      pnl = fl2(exitPnl);
      reason = 'TP_TIME';
      closed = true;
    }

    if (closed) {
      const exitFee = fl2(pos.size * TAKER_FEE);
      totalFees = fl4(totalFees + exitFee);
      pnl = fl2(pnl - exitFee);

      // True net PnL = trading PnL - entry fee - exit fee
      // entry fee was already subtracted from balance at position open
      const netPnl = fl2(pnl - pos.entryFee);

      pos.status = 'closed';
      pos.closeTime = Date.now();
      pos.pnl = netPnl;
      pos.exitReason = reason;
      pos.exitPrice = price;
      totalRealizedPnl = fl4(totalRealizedPnl + netPnl);
      lockedMargin = fl2(lockedMargin - pos.margin);
      balance = fl2(balance + pnl); // balance already had entryFee subtracted at entry

      if (netPnl >= 0) wins++; else losses++;
      trades.push({ ...pos });
      if (trades.length > 200) trades = trades.slice(-200);
      positions.splice(i, 1);

      const emoji = reason === 'SL' ? '🔴' : '🟢';
      logFn(`${emoji} ${reason} ${pos.symbol} (${pos.timeframe}) | Entry:$${pos.entryPrice} SL:$${pos.slPrice} | PnL:$${fl2(pos.pnl)}`);
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

  for (const tf of TIMEFRAMES) {
    if (now - (lastScan[tf.name] || 0) < tf.scanMs) continue;
    lastScan[tf.name] = now;

    // Fetch candles in chunks of 5 to avoid overwhelming API
    const symbols = [...activeSymbols];
    const results = [];
    for (let i = 0; i < symbols.length; i += 5) {
      const chunk = symbols.slice(i, i + 5);
      const chunkResults = await Promise.all(chunk.map(async (symbol) => {
      const candles = await getCandles(symbol, tf.granularity);
      if (!Array.isArray(candles) || candles.length < 3) return null;

      const prev = candles[candles.length - 2];
      const prevEndTs = parseInt(prev[0]);
      const candleDuration = tf.name === '15m' ? 900000 : (tf.name === '1H' ? 3600000 : (tf.name === '4H' ? 14400000 : 86400000));
      const candleEndTime = prevEndTs + candleDuration;

      if (now < candleEndTime) return null;
      if (now - candleEndTime > candleDuration * 1.5) return null;

      const signal = checkCandleSignal(candles);
      
      // Update monitored pair candle data per timeframe
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
      
      if (!signal) return null;
      return { symbol, signal, tf, pair };
    }));

      results.push(...chunkResults);
    }
    // Process signals
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
      trades: trades.slice(-200), positions: positions.filter(p => p.status === 'open'),
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
  const totalEquity = fl2(balance + openUpl); // balance already has fees subtracted
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
  logFn(`✅ Candle Bot v${STATE_VERSION} | DEMO $${fl2(balance)} | 15m/1H/4H/1D`);
  logFn(`📊 Signal: prev candle color | Entry: next open | SL: candle low/high | TP: 2 candles`);
  setTimeout(tick, 5000);
  setInterval(tick, 60000);
  // Fast price update loop for live dashboard (every 5s)
  setInterval(async () => {
    try {
      // Update pair prices from ticker cache
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



// ── Backtest ──
async function fetchAllCandles(symbol, granularity) {
  // Bitget API returns up to 200 candles (most recent data)
  // 15m: ~2 days, 1H: ~8 days, 4H: ~33 days, 1D: ~90 days
  const data = await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=200`);
  return Array.isArray(data) ? data : [];
}

async function runBacktest(options = {}) {
  const { daysBack = 30, topPairs = 5 } = options;
  const results = { timeframe: {}, overall: { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, winRate: 0 } };
  
  // Get top gainers/losers
  const tickers = await getAllTickers();
  if (!Array.isArray(tickers)) return { error: 'Failed to fetch tickers' };
  const usdt = tickers.filter(t => t.symbol.endsWith('USDT') && parseFloat(t.usdtVolume || 0) >= MIN_VOLUME);
  const withChange = usdt.map(t => {
    const last = parseFloat(t.lastPr || 0);
    const open = parseFloat(t.open24h || 0);
    return { symbol: t.symbol, change: open > 0 ? ((last - open) / open) * 100 : 0, price: last };
  }).filter(t => t.price > 0);
  withChange.sort((a, b) => b.change - a.change);
  const symbols = [
    ...withChange.slice(0, topPairs).map(t => t.symbol),
    ...withChange.slice(-topPairs).reverse().map(t => t.symbol)
  ];
  const uniqueSymbols = [...new Set(symbols)];
  
  for (const symbol of uniqueSymbols) {
    for (const tf of TIMEFRAMES) {
      const tfKey = tf.name;
      if (!results.timeframe[tfKey]) results.timeframe[tfKey] = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0 };
      
      const candles = await fetchAllCandles(symbol, tf.granularity, daysBack);
      if (candles.length < 3) continue;
      
      // Run strategy: iterate through candles, check signal on each closed candle
      let btBalance = DEMO_BALANCE;
      let btPositions = [];
      let btTrades = [];
      
      for (let i = 2; i < candles.length; i++) {
        // Get slice of last 3 candles up to index i
        const slice = candles.slice(0, i + 1);
        const signal = checkCandleSignal(slice);
        if (!signal) continue;
        
        const isBuy = signal.direction === 'BUY';
        const entryCandle = candles[i]; // candle after signal
        if (!entryCandle) continue;
        const entry = parseFloat(entryCandle[1]); // open of next candle
        if (!entry) continue;
        
        const sl = isBuy ? signal.candleLow : signal.candleHigh;
        const margin = fl2(DEMO_BALANCE * CAPITAL_PCT);
        if (btBalance < margin) continue;
        
        const size = fl2(margin * LEVERAGE);
        const entryFee = fl2(size * TAKER_FEE);
        btBalance = fl2(btBalance - entryFee);
        
        // Find exit: scan forward 2 candle durations for SL hit or time exit
        const candleMs = tf.name === '15m' ? 900000 : (tf.name === '1H' ? 3600000 : (tf.name === '4H' ? 14400000 : 86400000));
        const exitIdx = Math.min(i + 2, candles.length - 1); // exit after 2 candles
        let exitPrice = null;
        let exitReason = 'TP_TIME';
        
        // Check SL in the next 2 candles
        for (let j = i + 1; j <= exitIdx && j < candles.length; j++) {
          const c = candles[j];
          const cLow = parseFloat(c[3]);
          const cHigh = parseFloat(c[2]);
          if (isBuy && cLow <= sl) { exitPrice = sl; exitReason = 'SL'; break; }
          if (!isBuy && cHigh >= sl) { exitPrice = sl; exitReason = 'SL'; break; }
        }
        
        if (!exitPrice) {
          exitPrice = parseFloat(candles[exitIdx][4]); // close of exit candle
        }
        
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
        
        btTrades.push({ symbol, direction: signal.direction, entry, exitPrice, pnl: netPnl, exitReason, time: entryCandle[0] });
      }
      
    }
  }
  
  // Aggregate overall results after all symbols processed
  const o = results.overall;
  for (const tfKey of Object.keys(results.timeframe)) {
    const tf = results.timeframe[tfKey];
    o.trades += tf.trades;
    o.wins += tf.wins;
    o.losses += tf.losses;
    o.pnl = fl4(o.pnl + tf.pnl);
    o.fees = fl4(o.fees + tf.fees);
  }
  
  results.overall.winRate = results.overall.trades > 0 
    ? fl4((results.overall.wins / results.overall.trades) * 100) : 0;
  results.overall.roi = fl4((results.overall.pnl / DEMO_BALANCE) * 100);
  
  return results;
}

module.exports = { start, buildSnapshot, runBacktest };
