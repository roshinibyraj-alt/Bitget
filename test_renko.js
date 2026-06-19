const API_BASE = 'https://api.bitget.com';

async function publicGet(path) {
  const res = await fetch(API_BASE + path);
  const d = await res.json();
  return d.code === '00000' ? d.data : null;
}

async function getCandles(symbol, granularity, limit) {
  return await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=${limit}`);
}

// Convert OHLCV candles to Renko bricks
function toRenko(candles, brickSizePct) {
  if (!candles || candles.length < 2) return [];
  const bricks = [];
  let lastClose = parseFloat(candles[0][4]); // start with first close
  const brickVal = lastClose * brickSizePct; // absolute brick size

  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const ts = parseInt(candles[i][0]);

    // Check for up bricks
    while (high >= lastClose + brickVal) {
      bricks.push({ open: lastClose, close: lastClose + brickVal, high: lastClose + brickVal, low: lastClose, dir: 1, time: ts });
      lastClose += brickVal;
    }
    // Check for down bricks
    while (low <= lastClose - brickVal) {
      bricks.push({ open: lastClose, close: lastClose - brickVal, high: lastClose, low: lastClose - brickVal, dir: -1, time: ts });
      lastClose -= brickVal;
    }
  }
  return bricks;
}

// Strategy 1: 3-brick trend reversal
function testStrategy1(bricks, capital = 10000) {
  let bal = capital, trades = 0, wins = 0, losses = 0, maxDD = 0, peak = capital;
  let pos = null; // { dir, entry, sl, tp }

  for (let i = 2; i < bricks.length; i++) {
    const b = bricks[i];
    const b1 = bricks[i-1];
    const b2 = bricks[i-2];

    if (pos) {
      // Exit check
      if (pos.dir === 1 && b.dir === -1) {
        const pnl = (b.open - pos.entry) / pos.entry * 2000; // fixed position
        bal += pnl;
        trades++; pnl >= 0 ? wins++ : losses++;
        pos = null;
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak;
        if (dd > maxDD) maxDD = dd;
      } else if (pos.dir === -1 && b.dir === 1) {
        const pnl = (pos.entry - b.open) / pos.entry * 2000;
        bal += pnl;
        trades++; pnl >= 0 ? wins++ : losses++;
        pos = null;
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }

    // Entry: 3 consecutive bricks same direction
    if (!pos && b.dir === 1 && b1.dir === 1 && b2.dir === 1) {
      pos = { dir: 1, entry: b2.open };
    } else if (!pos && b.dir === -1 && b1.dir === -1 && b2.dir === -1) {
      pos = { dir: -1, entry: b2.open };
    }
  }
  return { trades, wins, losses, winRate: trades > 0 ? wins/trades*100 : 0, pnl: bal - capital, roi: (bal-capital)/capital*100, maxDD: maxDD*100 };
}

// Strategy 2: 2-brick trend with martingale (double on loss, reset on win)
function testStrategy2(bricks, capital = 10000) {
  let bal = capital, trades = 0, wins = 0, losses = 0, maxDD = 0, peak = capital;
  let pos = null;
  let betSize = 200; // base bet size in dollars (10x on 2% brick ~ 20% margin)
  let currentBet = betSize;

  for (let i = 1; i < bricks.length; i++) {
    const b = bricks[i];
    const b1 = bricks[i-1];

    if (pos) {
      if (pos.dir !== b.dir) {
        const exitPrice = b.open;
        const diff = pos.dir === 1 ? (exitPrice - pos.entry) : (pos.entry - exitPrice);
        const pnl = (diff / pos.entry) * currentBet;
        bal += pnl;
        trades++;
        if (pnl >= 0) { wins++; currentBet = betSize; }
        else { losses++; currentBet = Math.min(currentBet * 2, bal * 0.5); }
        pos = null;
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }

    // Entry after 2 consecutive bricks same direction (on 3rd)
    if (!pos && b.dir !== b1.dir) {
      // Trend shift - enter in the new direction
      // Wait for at least 2 bricks of same direction
    }
    if (!pos && i >= 2 && bricks[i-2].dir === b1.dir && b1.dir === b.dir && b.dir === 1) {
      if (bal * 0.05 >= currentBet) {
        pos = { dir: 1, entry: bricks[i-2].open };
      }
    } else if (!pos && i >= 2 && bricks[i-2].dir === b1.dir && b1.dir === b.dir && b.dir === -1) {
      if (bal * 0.05 >= currentBet) {
        pos = { dir: -1, entry: bricks[i-2].open };
      }
    }
  }
  return { trades, wins, losses, winRate: trades > 0 ? wins/trades*100 : 0, pnl: bal - capital, roi: (bal-capital)/capital*100, maxDD: maxDD*100 };
}

// Strategy 3: 1-brick breakout with SL
function testStrategy3(bricks, capital = 10000) {
  let bal = capital, trades = 0, wins = 0, losses = 0, maxDD = 0, peak = capital;
  let pos = null;

  for (let i = 1; i < bricks.length; i++) {
    const b = bricks[i];

    if (pos) {
      // SL at 1 brick against us
      if (pos.dir === 1 && b.dir === -1) {
        const pnl = (b.close - pos.entry) / pos.entry * 2000;
        bal += pnl; trades++; pnl >= 0 ? wins++ : losses++;
        pos = null;
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak;
        if (dd > maxDD) maxDD = dd;
      } else if (pos.dir === -1 && b.dir === 1) {
        const pnl = (pos.entry - b.close) / pos.entry * 2000;
        bal += pnl; trades++; pnl >= 0 ? wins++ : losses++;
        pos = null;
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }

    // Entry on every brick
    if (!pos) {
      pos = { dir: b.dir, entry: b.dir === 1 ? b.open : b.open };
    }
  }
  return { trades, wins, losses, winRate: trades > 0 ? wins/trades*100 : 0, pnl: bal - capital, roi: (bal-capital)/capital*100, maxDD: maxDD*100 };
}

// Strategy 4: Renko + ATR-like with compounding position
function testStrategy4(bricks, capital = 10000) {
  let bal = capital, trades = 0, wins = 0, losses = 0, maxDD = 0, peak = capital;
  let pos = null;

  for (let i = 3; i < bricks.length; i++) {
    const b = bricks[i];
    const trend = [];
    for (let j = i - 3; j <= i; j++) trend.push(bricks[j].dir);

    if (pos) {
      if (pos.dir !== b.dir) {
        const exitPrice = b.open;
        const diff = pos.dir === 1 ? (exitPrice - pos.entry) : (pos.entry - exitPrice);
        const posSize = bal * 0.1; // 10% of balance per trade
        const pnl = (diff / pos.entry) * posSize;
        bal += pnl;
        trades++; pnl >= 0 ? wins++ : losses++;
        pos = null;
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }

    if (!pos && trend.filter(t => t === 1).length === 4) {
      pos = { dir: 1, entry: bricks[i-3].open };
    } else if (!pos && trend.filter(t => t === -1).length === 4) {
      pos = { dir: -1, entry: bricks[i-3].open };
    }
  }
  return { trades, wins, losses, winRate: trades > 0 ? wins/trades*100 : 0, pnl: bal - capital, roi: (bal-capital)/capital*100, maxDD: maxDD*100 };
}

async function main() {
  const symbol = 'BEATUSDT';
  const timeframes = ['1H', '4H', '1D'];
  const brickPcts = [0.005, 0.01, 0.02, 0.03, 0.05]; // 0.5%, 1%, 2%, 3%, 5%

  for (const tf of timeframes) {
    const candles = await getCandles(symbol, tf, 200);
    if (!candles || candles.length < 10) continue;
    // Reverse so newest is last
    candles.reverse();

    console.log(`\n========== ${tf} (${candles.length} candles) ==========`);

    for (const bp of brickPcts) {
      const bricks = toRenko(candles, bp);
      if (bricks.length < 10) continue;

      console.log(`\n--- ${(bp*100).toFixed(1)}% brick (${bricks.length} bricks) ---`);

      // Test all strategies
      const s1 = testStrategy1(bricks, 10000);
      const s3 = testStrategy3(bricks, 10000);
      const s4 = testStrategy4(bricks, 10000);

      console.log(`  S1 (3-brick trend rev): ${s1.trades} trades | WR:${s1.winRate.toFixed(1)}% | PnL:$${s1.pnl.toFixed(0)} | DD:${s1.maxDD.toFixed(1)}% | ROI:${s1.roi.toFixed(1)}%`);
      console.log(`  S3 (1-brick every):    ${s3.trades} trades | WR:${s3.winRate.toFixed(1)}% | PnL:$${s3.pnl.toFixed(0)} | DD:${s3.maxDD.toFixed(1)}% | ROI:${s3.roi.toFixed(1)}%`);
      console.log(`  S4 (4-brick trend):    ${s4.trades} trades | WR:${s4.winRate.toFixed(1)}% | PnL:$${s4.pnl.toFixed(0)} | DD:${s4.maxDD.toFixed(1)}% | ROI:${s4.roi.toFixed(1)}%`);
    }
  }
}

main().catch(console.error);
