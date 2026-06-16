#!/bin/bash
LOG="monitor.log"
INTERVAL=1200 # 20 minutes

echo "=== MONITOR STARTED at $(date) ===" | tee -a $LOG

while true; do
  sleep $INTERVAL
  echo "=== CHECK $(date) ===" | tee -a $LOG
  
  # Get snapshot
  SNAP=$(curl -s http://localhost:3000/api/snapshot 2>/dev/null)
  if [ -z "$SNAP" ]; then
    echo "❌ Bot not responding!" | tee -a $LOG
    continue
  fi
  
  # Extract fields
  BAL=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('balance',0))")
  AVAIL=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('available',0))")
  LOCKED=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('locked',0))")
  POS=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('positions',[])))")
  WINS=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('wins',0))")
  LOSSES=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('losses',0))")
  FEES=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totalFees',0))")
  RP=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('realizedPnl',0))")
  UP=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('unrealizedPnl',0))")
  PAIRS=$(echo $SNAP | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('pairs',[])))")

  echo "  Capital: \$$BAL | Available: \$$AVAIL | Locked: \$$LOCKED" | tee -a $LOG
  echo "  Positions: $POS | W/L: $WINS/$LOSSES | Fees: \$$FEES" | tee -a $LOG
  echo "  Realized PnL: \$$RP | Unrealized: \$$UP | Pairs tracked: $PAIRS" | tee -a $LOG
  
  # Math verification: capital + locked + fees + realized should ~= starting
  # Starting = 30000. Current = balance (includes unrealized) + totalFees - realizedPnl = initial
  CHECK=$(python3 -c "print(round($BAL + $FEES - $RP, 2))" 2>/dev/null)
  echo "  Math check (balance+fees-realizedPnl, should be ~30000): $CHECK" | tee -a $LOG
  
  # Check each position PnL
  echo "  --- Position Details ---" | tee -a $LOG
  echo $SNAP | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in d.get('positions', []):
    up = p.get('unrealizedPnl', 0)
    entry = p.get('entryPrice', 0)
    mark = p.get('markPrice', 0)
    size = p.get('size', 0)
    direction = p.get('direction', '')
    tf = p.get('timeframe', '')
    sym = p.get('symbol', '')
    # Verify unrealized PnL math
    diff = (mark - entry) / entry * size if direction == 'BUY' else (entry - mark) / entry * size
    print(f'  {sym} {direction} {tf} | Entry: \${entry} Mark: \${mark} | Size: \${size} | Reported UPnL: \${up:.2f} Computed: \${diff:.2f} | Match: {\"OK\" if abs(up-diff)<0.1 else \"MISMATCH\"}')" 2>/dev/null | tee -a $LOG

  echo "" | tee -a $LOG
done
