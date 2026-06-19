const API_BASE = 'https://api.bitget.com';

async function publicGet(path) {
  const res = await fetch(API_BASE + path);
  const d = await res.json();
  return d.code === '00000' ? d.data : null;
}

async function getCandles(symbol, granularity, limit) {
  return await publicGet(`/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${symbol}&granularity=${granularity}&limit=${limit}`);
}

// Realistic Renko: convert candles to bricks, track close prices
function toRenko(candles, brickPct) {
  if (!candles || candles.length < 2) return [];
  const bricks = [];
  // Track actual closing prices for realistic exit/entry
  let brickHigh = parseFloat(candles[0][4]);
  let brickLow = brickHigh;
  let brickDir = 0; // 0 = flat, 1 = up, -1 = down
  let brickOpen = brickHigh;
  let openTs = parseInt(candles[0][0]);
  
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const ts = parseInt(candles[i][0]);
    const brickSize = brickHigh * brickPct;
    if (brickSize <= 0) continue;
    
    // Update running high/low
    if (high > brickHigh) brickHigh = high;
    if (low < brickLow) brickLow = low;
    
    // Check if a new brick forms
    const range = brickHigh - brickLow;
    if (range >= brickSize) {
      if (brickHigh === high) {
        // Up brick: price went up enough
        const close = brickLow + brickSize;
        bricks.push({ open: brickOpen, close, high: brickHigh, low: brickLow, dir: 1, time: openTs, size: brickSize });
        brickOpen = close;
        brickLow = close;
        brickHigh = close;
        openTs = ts;
      } else {
        // Down brick
        const close = brickHigh - brickSize;
        bricks.push({ open: brickOpen, close, high: brickHigh, low: brickLow, dir: -1, time: openTs, size: brickSize });
        brickOpen = close;
        brickLow = close;
        brickHigh = close;
        openTs = ts;
      }
    }
  }
  return bricks;
}

// Strategy: 3-brick trend entry, exit at 1st opposite + realistic pricing
function testStrategy(candles, brickPct, capital = 10000, leverage = 10, betPct = 0.02) {
  const bricks = toRenko(candles, brickPct);
  if (bricks.length < 10) return null;
  
  let bal = capital, trades = 0, wins = 0, losses = 0;
  let maxDD = 0, peak = capital, pos = null;
  let totalFees = 0;

  for (let i = 2; i < bricks.length; i++) {
    const b = bricks[i];
    const b1 = bricks[i-1];
    const b2 = bricks[i-2];

    if (pos) {
      // Check exit using candle that formed this brick
      // Exit at the first brick that goes against us
      if (pos.dir !== b.dir) {
        // Use the brick's close as realistic exit
        const exitPrice = b.close;
        const diff = pos.dir === 1 ? (exitPrice - pos.entry) : (pos.entry - exitPrice);
        const posSize = bal * betPct * leverage;
        const fee = posSize * 0.0006;
        const tradingPnl = (diff / pos.entry) * posSize;
        const netPnl = tradingPnl - fee * 2; // entry + exit fees
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

    // Entry: 3 consecutive bricks same direction
    if (!pos && b.dir === 1 && b1.dir === 1 && b2.dir === 1) {
      const posSize = bal * betPct * leverage;
      if (posSize > 0 && posSize < bal * 5) {
        pos = { dir: 1, entry: b.close };
      }
    } else if (!pos && b.dir === -1 && b1.dir === -1 && b2.dir === -1) {
      const posSize = bal * betPct * leverage;
      if (posSize > 0 && posSize < bal * 5) {
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
  const timeframes = ['1H', '4H'];
  const brickPcts = [0.005, 0.01, 0.02, 0.03];
  const leverages = [5, 10];
  const betPcts = [0.01, 0.02, 0.05];

  console.log('=== Renko Strategy Backtest ===');
  console.log('Symbol:', symbol);
  console.log('3-brick trend entry, exit at 1st opposite');
  console.log('Fees: 0.06% per trade');
  console.log('');

  for (const tf of timeframes) {
    const candles = await getCandles(symbol, tf, 200);
    if (!candles || candles.length < 10) continue;
    candles.reverse();
    console.log(`\n====== ${tf} (${candles.length} candles) ======`);

    let best = { roi: -Infinity };
    for (const bp of brickPcts) {
      console.log(`\n-- ${(bp*100).toFixed(1)}% brick --`);
      for (const lev of leverages) {
        for (const bet of betPcts) {
          const r = testStrategy(candles, bp, 10000, lev, bet);
          if (!r || r.trades < 5) continue;
          const flag = parseFloat(r.roi) > parseFloat(best.roi) ? ' ★ BEST' : '';
          if (parseFloat(r.roi) > parseFloat(best.roi)) best = r;
          console.log(`  x${lev} ${(bet*100).toFixed(1)}%: ${r.trades} tr | WR:${r.winRate}% | PnL:$${r.pnl} | ROI:${r.roi}% | DD:${r.maxDD}% | Fees:$${r.fees}${flag}`);
        }
      }
    }
    console.log(`\n  ★ BEST: WR:${best.winRate}% PnL:$${best.pnl} ROI:${best.roi}% DD:${best.maxDD}%`);
  }
}

main().catch(console.error);
