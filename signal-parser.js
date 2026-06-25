'use strict';

// ── Telegram Signal Parser ──────────────────────────────────────────────────

const KNOWN_PAIRS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'DOT', 'AVAX', 'LINK',
  'MATIC', 'UNI', 'ATOM', 'LTC', 'BCH', 'XLM', 'NEAR', 'FIL', 'APT', 'ARB',
  'OP', 'SUI', 'PEPE', 'INJ', 'RUNE', 'AAVE', 'MKR', 'CRV', 'FET', 'AGIX',
  'SAND', 'MANA', 'AXS', 'FTM', 'ALGO', 'EGLD', 'FLOW', 'MINA', 'KAS',
  'ICP', 'QNT', 'ETC', 'RNDR', 'STX', 'IMX', 'SEI', 'TIA', 'ORDI', '1000PEPE',
  'SHIB', 'WIF', 'BONK', 'FLOKI', 'PEOPLE', 'PENDLE', 'STRK', 'ENA', 'WLD',
  'TAO', 'AR', 'BEAM', 'JUP', 'PYTH', 'ONDO'
];
const PAIR_SET = new Set(KNOWN_PAIRS);
// Pairs that trade below $1
const MICRO_PAIRS = new Set(['PEPE', 'SHIB', 'BONK', 'FLOKI', '1000PEPE', 'PEOPLE', 'ADA', 'DOGE', 'XRP']);

function parseSignal(text) {
  if (!text || typeof text !== 'string') return null;

  // ── Direction ──
  let direction = null;
  const upper = text.toUpperCase().trim();
  if (/\b(LONG|BUY)\b/.test(upper)) direction = 'LONG';
  else if (/\b(SHORT|SELL)\b/.test(upper)) direction = 'SHORT';
  if (!direction) return null;

  // ── Pair ──
  let pair = null;
  const dollarMatch = upper.match(/\$([A-Z0-9]+)/);
  if (dollarMatch) {
    const p = dollarMatch[1].replace(/USDT$/i, '');
    if (PAIR_SET.has(p)) pair = p;
  }
  if (!pair) {
    const slashMatch = upper.match(/\b([A-Z0-9]+)\/USDT\b/);
    if (slashMatch) { const p = slashMatch[1]; if (PAIR_SET.has(p)) pair = p; }
  }
  if (!pair) {
    const hashMatch = upper.match(/#([A-Z0-9]+)/);
    if (hashMatch) { const p = hashMatch[1].replace(/USDT$/i, ''); if (PAIR_SET.has(p)) pair = p; }
  }
  if (!pair) {
    for (const p of KNOWN_PAIRS) {
      if (new RegExp('\\b' + p + '\\b').test(upper)) { pair = p; break; }
    }
  }
  if (!pair) return null;

  // ── Extract numbered values after keywords ──
  function valueAfter(keywords) {
    for (const kw of keywords) {
      const kwEscaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match: keyword followed by optional symbols, then a number (with optional k/m suffix)
      const re = new RegExp(
        '(?:' + kwEscaped + '\\s*[:=–—]?\\s*' +
        '|[' + '📥🎯🛑📈💰' + ']\\s*' + kwEscaped + '\\s*[:=–—]?\\s*)' +
        '(\\d+[.,]?\\d*)\\s*(k|m)?',
        'i'
      );
      const m = text.match(re);
      if (m) {
        let val = parseFloat(m[1].replace(',', ''));
        const suffix = (m[2] || '').toLowerCase();
        if (suffix === 'k') val *= 1000;
        else if (suffix === 'm') val *= 1000000;
        // Basic filter: skip single-digit numbers that aren't prices
        if (val > 0 && (val >= 0.0000001 || !MICRO_PAIRS.has(pair))) {
          if (val >= 0.0000001) return val;
        }
      }
    }
    return null;
  }

  const entry = valueAfter(['ENTRY', 'ENTRY ZONE', 'ENTRY PRICE', 'ENTER', '📥']);
  const tp = valueAfter(['TP', 'TP1', 'TP2', 'TP3', 'TARGET', 'TAKE PROFIT', '🎯', 'TARGETS']);
  const sl = valueAfter(['SL', 'STOP', 'STOP LOSS', '🛑', 'STOP']);

  // If no TP/SL found with keywords, try scanning for numbers in the text
  if (!tp && !sl) {
    const allNums = [];
    const numRe = /(\d+[.,]?\d*)\s*(k|m)?/gi;
    let m;
    while ((m = numRe.exec(text)) !== null) {
      let val = parseFloat(m[1].replace(',', ''));
      const suffix = (m[2] || '').toLowerCase();
      if (suffix === 'k') val *= 1000;
      else if (suffix === 'm') val *= 1000000;
      if (val >= 0.0000001) allNums.push(val);
    }
    
    if (allNums.length >= 2 && !entry) {
      return { pair, direction, entry: allNums[0], tp: allNums[allNums.length - 1], sl: null };
    }
    if (allNums.length >= 3 && entry) {
      // Entry + TP + SL inline: "LONG BTC 65k 68k 63k"
      return { pair, direction, entry: allNums[0], tp: allNums[1], sl: allNums[2] };
    }
  }

  return { pair, direction, entry, tp, sl };
}

module.exports = { parseSignal, KNOWN_PAIRS };
