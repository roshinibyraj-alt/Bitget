const API_BASE = 'https://api.bitget.com';

async function publicGet(path) {
  const res = await fetch(API_BASE + path);
  const d = await res.json();
  return d.code === '00000' ? d.data : null;
}

async function getCandles(symbol, granularity, limit) {
  return await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=${limit}`);
}

// Convert OHLCV candles to Renko bricks (fixed version)
function toRenko(candles, brickPct) {
  if (!candles || candles.length < 3) return [];
  const bricks = [];
  let refPrice = parseFloat(candles[0][1]); // start with first open
  const brickSize = refPrice * brickPct;
  if (brickSize <= 0) return [];
  
  for (let i = 0; i < candles.length; i++) {
    const open = parseFloat(candles[i][1]);
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const close = parseFloat(candles[i][4]);
    const ts = parseInt(candles[i][0]);

    // Simulate price path: open → high → low → close
    const path = [open, high, low, close];
    // But more realistic: open → high (if close > open) or open → low (if close < open)
    let prices;
    if (close >= open) {
      prices = [open, high, low, close];
    } else {
      prices = [open, low, high, close];
    }

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

// 3-brick trend strategy with realistic position sizing
function runBacktest(candles, brickPct, capital = 10000, leverage = 5, betPct = 0.02) {
  const bricks = toRenko(candles, brickPct);
  if (bricks.length < 10) return null;

  let bal = capital, trades = 0, wins = 0, losses = 0;
  let maxDD = 0, peak = capital;
  let pos = null;
  let totalFees = 0;

  for (let i = 2; i < bricks.length; i++) {
    const b = bricks[i];
    const b1 = bricks[i-1];
    const b2 = bricks[i-2];

    if (pos) {
      if (pos.dir !== b.dir) {
        const exitPrice = b.close;
        const diff = pos.dir === 1 ? (exitPrice - pos.entry) : (pos.entry - exitPrice);
        const posSize = bal * betPct;
        const margin = posSize;
        const size = margin * leverage;
        const fee = size * 0.0006;
        const tradingPnl = (diff / pos.entry) * size;
        const netPnl = tradingPnl - fee * 2;
        bal += netPnl;
        totalFees += fee * 2;
        trades++;
        if (netPnl >= 0) wins++; else losses++;
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak;
        if (dd > maxDD) maxDD = dd;
        pos = null;
      }
    }

    if (!pos && b.dir === 1 && b1.dir === 1 && b2.dir === 1) {
      const margin = bal * betPct;
      if (margin > 0 && margin < bal * 0.5) {
        pos = { dir: 1, entry: b.close };
      }
    } else if (!pos && b.dir === -1 && b1.dir === -1 && b2.dir === -1) {
      const margin = bal * betPct;
      if (margin > 0 && margin < bal * 0.5) {
        pos = { dir: -1, entry: b.close };
      }
    }
  }

  return {
    trades, wins, losses,
    winRate: trades > 0 ? (wins/trades*100).toFixed(1) : 0,
    pnl: (bal - capital).toFixed(0),
    roi: ((bal-capital)/capital*100).toFixed(1),
    maxDD: (maxDD*100).toFixed(1),
    fees: totalFees.toFixed(0)
  };
}

// Martingale variant: double on loss, reset on win
function runMartingale(candles, brickPct, capital = 10000, leverage = 10, baseBet = 0.01) {
  const bricks = toRenko(candles, brickPct);
  if (bricks.length < 10) return null;

  let bal = capital, trades = 0, wins = 0, losses = 0;
  let maxDD = 0, peak = capital;
  let pos = null;
  let currentBet = baseBet;
  let totalFees = 0;

  for (let i = 2; i < bricks.length; i++) {
    const b = bricks[i];
    const b1 = bricks[i-1];
    const b2 = bricks[i-2];

    if (pos) {
      if (pos.dir !== b.dir) {
        const exitPrice = b.close;
        const diff = pos.dir === 1 ? (exitPrice - pos.entry) : (pos.entry - exitPrice);
        const margin = bal * currentBet;
        const size = margin * leverage;
        const fee = size * 0.0006;
        const tradingPnl = (diff / pos.entry) * size;
        const netPnl = tradingPnl - fee * 2;
        bal += netPnl;
        totalFees += fee * 2;
        trades++;
        if (netPnl >= 0) { wins++; currentBet = baseBet; }
        else { losses++; currentBet = Math.min(currentBet * 2, 0.5); }
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak;
        if (dd > maxDD) maxDD = dd;
        pos = null;
      }
    }

    if (!pos && b.dir === 1 && b1.dir === 1 && b2.dir === 1) {
      const margin = bal * currentBet;
      if (margin > 0 && margin < bal * 0.5) {
        pos = { dir: 1, entry: b.close };
      }
    } else if (!pos && b.dir === -1 && b1.dir === -1 && b2.dir === -1) {
      const margin = bal * currentBet;
      if (margin > 0 && margin < bal * 0.5) {
        pos = { dir: -1, entry: b.close };
      }
    }
  }

  return {
    trades, wins, losses,
    winRate: trades > 0 ? (wins/trades*100).toFixed(1) : 0,
    pnl: (bal - capital).toFixed(0),
    roi: ((bal-capital)/capital*100).toFixed(1),
    maxDD: (maxDD*100).toFixed(1),
    fees: totalFees.toFixed(0)
  };
}

async function main() {
  const symbol = 'BEATUSDT';
  const configs = [
    { tf: '1H', brickPct: 0.01, lev: 5, bet: 0.02 },
    { tf: '1H', brickPct: 0.02, lev: 5, bet: 0.02 },
    { tf: '1H', brickPct: 0.03, lev: 5, bet: 0.02 },
    { tf: '4H', brickPct: 0.01, lev: 5, bet: 0.02 },
    { tf: '4H', brickPct: 0.02, lev: 5, bet: 0.02 },
    { tf: '4H', brickPct: 0.03, lev: 5, bet: 0.02 },
    { tf: '1D', brickPct: 0.01, lev: 5, bet: 0.02 },
    { tf: '1D', brickPct: 0.02, lev: 5, bet: 0.02 },
    { tf: '1D', brickPct: 0.03, lev: 5, bet: 0.02 },
  ];

  // Also test martingale
  const martConfigs = [
    { tf: '1H', brickPct: 0.02, lev: 10, base: 0.01 },
    { tf: '4H', brickPct: 0.03, lev: 10, base: 0.01 },
  ];

  console.log('=== Renko 3-Brick Trend Strategy ===');
  console.log(`Symbol: ${symbol}`);
  console.log('Entry: 3 consecutive bricks same direction');
  console.log('Exit: 1st opposite brick');
  console.log('');

  for (const c of configs) {
    const candles = await getCandles(symbol, c.tf, 200);
    if (!candles || candles.length < 10) continue;
    candles.reverse();
    
    const r = runBacktest(candles, c.brickPct, 10000, c.lev, c.bet);
    if (!r || r.trades < 3) {
      console.log(`  ${c.tf} ${(c.brickPct*100).toFixed(1)}%: No trades`);
      continue;
    }
    console.log(`  ${c.tf} ${(c.brickPct*100).toFixed(1)}% brick x${c.lev} ${(c.bet*100).toFixed(1)}%: ${r.trades} tr | WR:${r.winRate}% | PnL:\$${r.pnl} | ROI:${r.roi}% | DD:${r.maxDD}%`);
  }

  console.log('\n--- Martingale variants ---');
  for (const c of martConfigs) {
    const candles = await getCandles(symbol, c.tf, 200);
    if (!candles || candles.length < 10) continue;
    candles.reverse();
    const r = runMartingale(candles, c.brickPct, 10000, c.lev, c.base);
    if (!r || r.trades < 3) continue;
    console.log(`  ${c.tf} ${(c.brickPct*100).toFixed(1)}% x${c.lev} martingale ${(c.base*100).toFixed(1)}%: ${r.trades} tr | WR:${r.winRate}% | PnL:\$${r.pnl} | ROI:${r.roi}% | DD:${r.maxDD}%`);
  }
}

main().catch(console.error);
