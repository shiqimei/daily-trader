# Orderbook TUI

A real-time orderbook analyzer with Terminal User Interface (TUI) that monitors velocity, patterns, and generates trading signals based on orderbook dynamics.

## Features

- **Real-time WebSocket Integration**: Connects to Binance futures orderbook stream
- **Velocity Analysis**: Calculates bid/ask velocity and rate of change
- **Pattern Detection**: Identifies 7 types of orderbook patterns:
  - Liquidity Withdrawal
  - Liquidity Surge
  - Accumulation/Distribution
  - Market Maker Shift
  - Sweep Preparation
  - Iceberg Orders
- **Signal Generation**: Generates trading signals with entry, TP, and SL levels
- **Visual Display**: Clean terminal UI with real-time updates

## Usage

```bash
# Basic usage
pnpm orderbook BTCUSDC

# With options
pnpm orderbook ETHUSDC --depth 20 --window 30 --min-signal 70

# Or directly with npx
npx tsx src/bin/orderbook.ts BCHUSDC
```

## Options

- `--depth <number>`: Orderbook depth levels (default: 10)
- `--window <number>`: Analysis window size (default: 20)
- `--min-signal <number>`: Minimum signal strength 0-100 (default: 60)
- `--update-speed <number>`: Update speed in ms - 100 or 1000 (default: 100)

## TUI Layout

The TUI provides a fixed layout with 6 panels:

```
┌─ Orderbook ─────────────┬─ Velocity Metrics ──────┐
│ Real-time bid/ask       │ Velocity calculations   │
│ with spread display     │ and flow metrics        │
├─ Detected Patterns ─────┼─ Trading Signal ────────┤
│ Active patterns with    │ Current signal with     │
│ confidence levels       │ entry/TP/SL levels      │
├─ Statistics ────────────┼─ Log ───────────────────┤
│ Market state and        │ Event log with          │
│ pattern counts          │ timestamps              │
└─────────────────────────┴─────────────────────────┘
```

## Display Components

### Orderbook View
Shows top 5 bid/ask levels with size visualization:
```
ASK  3717.10 │     0.5432 ████████
ASK  3717.09 │     0.3210 █████
ASK  3717.08 │     0.2100 ███
---------------------------------------------
     SPREAD: 0.02 │ MID: 3717.07
---------------------------------------------
BID  3717.06 │     0.4321 ███████
BID  3717.05 │     0.5678 █████████
```

### Velocity Metrics
- **Bid/Ask Velocity**: Rate of liquidity change (units/second)
- **Bid/Ask Rate**: Percentage change rate (%/second)
- **Price Velocity**: Price movement speed ($/second)
- **Imbalance Ratio**: Bid velocity / Ask velocity

### Pattern Detection
Identifies and displays real-time patterns:
- **LIQUIDITY_WITHDRAWAL**: Rapid removal of orders from one side
- **LIQUIDITY_SURGE**: Sudden increase in orders without price movement
- **ACCUMULATION**: Persistent bid liquidity despite falling price
- **DISTRIBUTION**: Persistent ask liquidity despite rising price
- **SWEEP_PREP**: Potential preparation for liquidity sweep
- **MARKET_MAKER_SHIFT**: Symmetric adjustment of quotes

### Trading Signals
When conditions are met, generates signals with:
- Direction (LONG/SHORT)
- Confidence (HIGH/MEDIUM/LOW)
- Entry price
- Take profit (0.5 ATR)
- Stop loss (1.0 ATR)
- Reason for signal

## Architecture

1. **WebSocket Client** (`BinanceOrderbookWSSimple`):
   - Maintains orderbook state
   - Handles reconnection
   - Processes incremental updates

2. **Dynamics Analyzer** (`OrderbookDynamics`):
   - Calculates derivatives (velocity, rates)
   - Detects patterns
   - Generates trading signals

3. **Circular Buffer**:
   - Efficient storage for time-series data
   - Rolling window analysis

4. **Display Manager**:
   - Real-time terminal UI
   - Color-coded information
   - Performance statistics

## Signal Logic

Signals are generated based on:
1. Pattern confluence (multiple patterns detected)
2. Velocity imbalance
3. Minimum signal strength threshold
4. Cooldown period (3 seconds between signals)

Long signals triggered by:
- Strong ask withdrawal
- Accumulation patterns
- Extreme positive imbalance ratio

Short signals triggered by:
- Strong bid withdrawal
- Bid surge without price movement
- Extreme negative imbalance ratio

## Performance Tips

- Use `--update-speed 1000` for lower CPU usage
- Adjust `--window` size based on market conditions
- Set higher `--min-signal` for fewer but stronger signals
- Monitor pattern counts to understand market behavior

## Example Patterns

### Accumulation Pattern
```
LIQUIDITY_SURGE      │ BID   │ Strength: 65% │ Buy orders surging but price stable
LIQUIDITY_SURGE      │ BID   │ Strength: 70% │ Buy orders surging but price stable
ACCUMULATION         │ BID   │ Strength: 70% │ Persistent bid liquidity despite falling price
```

### Sweep Preparation
```
LIQUIDITY_WITHDRAWAL │ ASK   │ Strength: 85% │ Sellers withdrawing liquidity rapidly
SWEEP_PREP          │ ASK   │ Strength: 75% │ Potential sweep preparation detected
```

## Exit

Press `Ctrl+C` to gracefully shutdown the monitor.