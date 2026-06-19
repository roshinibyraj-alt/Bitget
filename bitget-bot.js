'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──
const API_BASE = 'https://api.bitget.com';
const DEMO_BALANCE = 30000;
const LEVERAGE = 3;
const BET_PCT = 0.01; // 1% of equity per trade
const BRICK_PCT = 0.02; // 2% Renko brick size
const TAKER_FEE = 0.0006;

const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 9;

const TIMEFRAMES = [
  { name: '4H', granularity: '4H', scanMs: 14400000 },
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
let emitFn = (e, d) => {};
let logFn = (m) => {};
let startTime = Date.now();
let lastBrickRef = null;
let lastBrickDir = 0;
let brickCount = 0;
let signalLog = [];

function fl2(v) { return Math.round((v || 0) * 100) / 100; }
function fl4(v) { return Math.round((v || 0) * 10000) / 10000; }

// ── API ──
async function publicGet(path) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    const res = await fetch(API_BASE + path, { signal: c.signal });
    clearTimeout(t);
    const data = await res.json();
    return data.code === '00000' ? data.data : null;
  } catch (_) { return null; }
}

async function getCandles(symbol, granularity, limit) {
  return await publicGet('/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=' + symbol + '&granularity=' + granularity + '&limit=' + limit);
}

// ── Renko Brick Conversion ──
function toRenko(candles) {
  if (!candles || candles.length < 3) return [];
  const bricks = [];
  let refPrice = parseFloat(candles[0][1]) || 0.01;
  
  for (let i = 0; i < candles.length; i++) {
    const o = parseFloat(candles[i][1]), h = parseFloat(candles[i][2]);
    const l = parseFloat(candles[i][3]), c = parseFloat(candles[i][4]);
    const ts = parseInt(candles[i][0]);
    if (!o || !h || !l || !c) continue;
    const brickSize = Math.max(refPrice * BRICK_PCT, 0.0001);
    const prices = c >= o ? [o, h, l, c] : [o, l, h, c];
    for (const p of prices) {
      while (p >= refPrice + brickSize) {
        bricks.push({ close: refPrice + brickSize, dir: 1, time: ts });
        refPrice += brickSize;
      }
      while (p <= refPrice - brickSize) {
        bricks.push({ close: refPrice - brickSize, dir: -1, time: ts });
        refPrice -= brickSize;
      }
    }
  }
  return bricks;
}

// ── Renko Signal: 3 consecutive bricks same direction ──
function checkRenkoSignal(candles) {
  const bricks = toRenko(candles);
  if (bricks.length < 3) return null;
  
  // Only check the last 3 bricks
  const b = bricks[bricks.length - 1];
  const b1 = bricks[bricks.length - 2];
  const b2 = bricks[bricks.length - 3];
  
  if (b.dir === 1 && b1.dir === 1 && b2.dir === 1) {
    return { direction: 'BUY', entry: b.close, time: b.time, bricks };
  }
  if (b.dir === -1 && b1.dir === -1 && b2.dir === -1) {
    return { direction: 'SELL', entry: b.close, time: b.time, bricks };
  }
  return null;
}

// ── Process Signal ──
function processSignal(symbol, signal) {
  const key = symbol + ':renko:' + signal.time;
  if (processedCandles[key]) return;
  processedCandles[key] = true;

  const isBuy = signal.direction === 'BUY';
  const entry = signal.entry;
  const equity = fl2(balance + positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0));
  const margin = fl2(equity * BET_PCT);
  if (equity - lockedMargin < margin * 0.5) return;

  const size = fl2(margin * LEVERAGE);
  if (size <= 0) return;

  const entryFee = fl2(size * TAKER_FEE);
  totalFees = fl4(totalFees + entryFee);
  balance = fl2(balance - entryFee);

  const pos = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    symbol, direction: signal.direction,
    entryPrice: entry, time: Date.now(),
    size, margin,
    entryFee,
    status: 'open', unrealizedPnl: 0, markPrice: entry,
  };
  lockedMargin = fl2(lockedMargin + margin);
  positions.push(pos);

  signalLog.push({
    symbol, direction: signal.direction, entryPrice: entry,
    time: Date.now(),
  });
  if (signalLog.length > 200) signalLog = signalLog.slice(-200);

  logFn('📊 ' + signal.direction + ' ' + symbol + ' (Renko 3-brick) | Entry: $' + entry);
  saveState();
  emitFn('snapshot', buildSnapshot());
}

// ── Backfill ──
let backfillDone = false;
let processedCandles = {};

async function backfillHistory() {
  if (backfillDone) return;
  backfillDone = true;

  logFn('📚 Backfilling Renko 3-brick strategy for BEATUSDT...');
  const candles = await getCandles('BEATUSDT', '4H', 200);
  if (!Array.isArray(candles) || candles.length < 10) return;
  candles.reverse();

  const bricks = toRenko(candles);
  logFn('📊 Generated ' + bricks.length + ' Renko bricks (' + (BRICK_PCT*100) + '% size)');
  let histTrades = 0;

  for (let i = 2; i < bricks.length; i++) {
    const b = bricks[i], b1 = bricks[i-1], b2 = bricks[i-2];
    if (!(b.dir === 1 && b1.dir === 1 && b2.dir === 1) && !(b.dir === -1 && b1.dir === -1 && b2.dir === -1)) continue;

    const isBuy = b.dir === 1;
    const entry = b.close;
    const key = 'BEATUSDT:renko:' + b.time;
    if (processedCandles[key]) continue;
    processedCandles[key] = true;

    const margin = fl2(DEMO_BALANCE * BET_PCT);
    const size = fl2(margin * LEVERAGE);
    const entryFee = fl2(size * TAKER_FEE);

    // Find exit: next brick in opposite direction
    let exitPrice = null, exitReason = 'TP_TIME';
    for (let j = i + 1; j < bricks.length; j++) {
      if (bricks[j].dir !== b.dir) {
        exitPrice = bricks[j].close;
        exitReason = 'TP';
        break;
      }
    }
    if (!exitPrice && i + 3 < bricks.length) exitPrice = bricks[i + 3].close;
    if (!exitPrice) continue;

    const diff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
    const tradingPnl = (diff / entry) * size;
    const exitFee = fl2(size * TAKER_FEE);
    const netPnl = fl2(tradingPnl - exitFee - entryFee);

    totalFees = fl4(totalFees + entryFee + exitFee);
    balance = fl2(balance + tradingPnl - exitFee - entryFee);
    totalRealizedPnl = fl4(totalRealizedPnl + netPnl);
    if (netPnl >= 0) wins++; else losses++;

    trades.push({
      symbol: 'BEATUSDT', direction: isBuy ? 'BUY' : 'SELL',
      entryPrice: entry, exitPrice, pnl: netPnl,
      margin, size, entryFee, timeframe: '4H-renko',
      exitReason, time: b.time, closeTime: exitPrice ? bricks.find(bx => bx.close === exitPrice)?.time || Date.now() : Date.now(),
    });
    histTrades++;
  }

  if (trades.length > 500) trades = trades.slice(-500);
  balance = fl2(balance);
  logFn('📚 Backfill: ' + histTrades + ' Renko trades | Bal: $' + fl2(balance));
  saveState();
}

// ── Update Positions ──
async function updatePositions() {
  const candles = await getCandles('BEATUSDT', '4H', 30);
  if (!Array.isArray(candles) || candles.length < 5) return;
  candles.reverse();
  const bricks = toRenko(candles);
  if (bricks.length < 3) return;

  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (pos.status !== 'open') continue;
    
    const price = bricks[bricks.length - 1].close;
    pos.markPrice = price;

    const isBuy = pos.direction === 'BUY';
    const diff = isBuy ? (price - pos.entryPrice) : (pos.entryPrice - price);
    pos.unrealizedPnl = fl2((diff / pos.entryPrice) * pos.size);

    let closed = false, pnl = 0, reason = '';

    // Exit: first opposite brick
    if (bricks.length >= 3) {
      const lastB = bricks[bricks.length - 1];
      const lastDir = lastB.dir;
      const entryDir = isBuy ? 1 : -1;
      if (lastDir !== entryDir) {
        pnl = fl2((diff / pos.entryPrice) * pos.size);
        reason = 'TP';
        closed = true;
      }
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
      logFn(emoji + ' ' + reason + ' BEATUSDT (Renko) | Entry:$' + pos.entryPrice + ' Exit:$' + price + ' | PnL:$' + fl2(netPnl));
      saveState();
      emitFn('snapshot', buildSnapshot());
    }
  }
}

// ── Scan ──
let lastScan = {};

async function scan() {
  const now = Date.now();
  for (const tf of TIMEFRAMES) {
    if (now - (lastScan[tf.name] || 0) < tf.scanMs) continue;
    lastScan[tf.name] = now;

    const candles = await getCandles('BEATUSDT', tf.granularity, 20);
    if (!Array.isArray(candles) || candles.length < 5) continue;
    candles.reverse();

    const signal = checkRenkoSignal(candles);
    if (signal) processSignal('BEATUSDT', signal);
  }
}

// ── State ──
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      stateVersion: STATE_VERSION, balance, lockedMargin, totalRealizedPnl, totalFees, wins, losses,
      trades: trades.slice(-300),
      positions: positions.filter(p => p.status === 'open'),
      signalLog: signalLog.slice(-200),
      processedCandles,
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
        // Sanity check
        const openFees = positions.reduce((s, p) => s + (p.entryFee || 0), 0);
        const expected = DEMO_BALANCE + totalRealizedPnl - openFees;
        if (Math.abs(balance - expected) > 100) {
          console.log('⚠️ Balance corruption: $' + balance + ' vs $' + expected + '. Resetting.');
          balance = expected;
        }
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
    balance: totalEquity,
    available: fl2(totalEquity - totalMargin),
    locked: fl2(totalMargin),
    totalPnl: fl4(totalRealizedPnl + openUpl),
    realizedPnl: fl4(totalRealizedPnl),
    unrealizedPnl: fl4(openUpl),
    totalFees: fl4(totalFees),
    wins, losses,
    totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4((wins / (wins + losses)) * 100) : 0,
    positions: positions.filter(p => p.status === 'open').map(p => ({
      symbol: p.symbol, direction: p.direction,
      entryPrice: p.entryPrice, size: p.size, margin: p.margin,
      timeframe: '4H-Renko', unrealizedPnl: p.unrealizedPnl || 0,
      markPrice: p.markPrice || 0, entryFee: p.entryFee || 0,
    })),
    signals: signalLog.slice(-40).reverse(),
    trades: trades.slice(-40).reverse().map(t => ({
      symbol: t.symbol, direction: t.direction,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice || 0,
      pnl: t.pnl, margin: t.margin, timeframe: t.timeframe,
      exitReason: t.exitReason, time: t.time, closeTime: t.closeTime,
    })),
    timeframes: ['4H-Renko'],
    demo: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activePairs: positions.filter(p => p.status === 'open').length,
    strategy: 'Renko 3-brick ' + (BRICK_PCT*100) + '%',
  };
}

// ── Tick ──
async function tick() {
  try {
    await scan();
    await updatePositions();
    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    logFn('⚠️ Tick: ' + e.message);
  }
}

// ── Start ──
async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  loadState();
  logFn('✅ Renko Bot v' + STATE_VERSION + ' | BEATUSDT | 4H ' + (BRICK_PCT*100) + '% brick | 3x lev ' + (BET_PCT*100) + '% bet | DEMO $' + fl2(balance));

  // Initial emit
  emitFn('snapshot', buildSnapshot());

  // Backfill
  await backfillHistory();

  // Live trading
  setTimeout(tick, 5000);
  setInterval(tick, 60000);

  // Fast price update
  setInterval(async () => {
    try {
      await updatePositions();
      emitFn('snapshot', buildSnapshot());
    } catch(e) {}
  }, 5000);

  emitFn('snapshot', buildSnapshot());
}

// ── Backtest (for dashboard) ──
async function runBacktest() {
  const candles = await getCandles('BEATUSDT', '4H', 200);
  if (!Array.isArray(candles)) return { error: 'No data' };
  candles.reverse();
  const bricks = toRenko(candles);
  let bal = DEMO_BALANCE, trades = 0, wins = 0, losses = 0, fees = 0;

  for (let i = 2; i < bricks.length; i++) {
    const b = bricks[i], b1 = bricks[i-1], b2 = bricks[i-2];
    if (!(b.dir === 1 && b1.dir === 1 && b2.dir === 1) && !(b.dir === -1 && b1.dir === -1 && b2.dir === -1)) continue;

    const isBuy = b.dir === 1;
    const entry = b.close;
    const margin = fl2(bal * BET_PCT);
    if (margin <= 0) continue;
    const size = fl2(margin * LEVERAGE);
    const entryFee = fl2(size * TAKER_FEE);
    bal -= entryFee;

    let exitPrice = null, reason = 'TP_TIME';
    for (let j = i + 1; j < bricks.length; j++) {
      if (bricks[j].dir !== b.dir) { exitPrice = bricks[j].close; reason = 'TP'; break; }
    }
    if (!exitPrice && i + 3 < bricks.length) exitPrice = bricks[i + 3].close;
    if (!exitPrice) continue;

    const diff = isBuy ? (exitPrice - entry) : (entry - exitPrice);
    const tradingPnl = (diff / entry) * size;
    const exitFee = fl2(size * TAKER_FEE);
    const netPnl = fl2(tradingPnl - exitFee - entryFee);
    bal += tradingPnl - exitFee;
    fees += entryFee + exitFee;
    trades++;
    if (netPnl >= 0) wins++; else losses++;
  }

  return {
    overall: { trades, wins, losses, pnl: fl2(bal - DEMO_BALANCE), fees: fl2(fees), winRate: trades > 0 ? fl4(wins/trades*100) : 0, roi: fl4((bal-DEMO_BALANCE)/DEMO_BALANCE*100) },
    timeframe: { '4H-Renko': { trades, wins, losses, pnl: fl2(bal - DEMO_BALANCE), fees: fl2(fees) } }
  };
}

module.exports = { start, buildSnapshot, runBacktest };
