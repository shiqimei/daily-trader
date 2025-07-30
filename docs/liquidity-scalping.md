# Liquidity Scalping Strategy v0.2.0

## Overview

The liquidity scalping strategy is an automated trading system that identifies and exploits short-term liquidity imbalances in orderbooks. It uses real-time orderbook dynamics to detect patterns like liquidity surges and withdrawals, placing maker orders to capture small but consistent profits.

## Key Features

- **Real-time orderbook analysis** using WebSocket connections
- **Pattern detection** for LIQUIDITY_SURGE, LIQUIDITY_WITHDRAWAL, and MARKET_MAKER_SHIFT
- **Risk-controlled position sizing** with 30% maximum risk per trade
- **Time-based exit rules** to prevent holding positions too long
- **Breakeven stop-loss management** to protect profits

## Strategy Logic

### 1. Market Selection
- Scans for markets with ATR between 40-80 basis points
- Prioritizes lower volatility for more predictable movements
- Requires sufficient volume (24h USDT volume)

### 2. Entry Signals
**Long Entry Conditions:**
- Bid LIQUIDITY_SURGE (buyers aggressively adding liquidity)
- Ask LIQUIDITY_WITHDRAWAL (sellers pulling liquidity)
- Spread > 1 tick (gap for maker order placement)

**Short Entry Conditions:**
- Ask LIQUIDITY_SURGE (sellers aggressively adding liquidity)
- Bid LIQUIDITY_WITHDRAWAL (buyers pulling liquidity)
- Spread > 1 tick

### 3. Position Management
- **Take Profit:** 1 ATR from entry (maker order)
- **Stop Loss:** 0.5 ATR from entry (stop market order)
- **Risk:Reward:** 2:1 ratio
- **Position Size:** Maximum 30% of account balance at risk

### 4. Exit Rules
- Move SL to breakeven at +5 basis points profit
- Exit 50% if no movement after 5 minutes
- Exit 50% if < 1R profit after 30 minutes
- Exit 80% after 1 hour regardless of P/L
- Quick exit all if > 2 minutes and +5bps profit

## Usage

### Live Trading
```bash
npm run liquidity-scalping
```

### Dry Run Mode (Simulation)
```bash
npm run liquidity-scalping -- --dry-run
```

### Command Line Options
- `-d, --dry-run`: Run in simulation mode without placing real orders
- `-v, --verbose`: Enable detailed logging
- `-h, --help`: Display help information

## Configuration

The strategy uses environment variables from `.env`:
- `BINANCE_API_KEY`: Your Binance API key
- `BINANCE_API_SECRET`: Your Binance API secret

## Pattern Detection

### LIQUIDITY_SURGE
- Rapid increase in order book depth
- Indicates strong interest at current price level
- Often precedes price movement in opposite direction

### LIQUIDITY_WITHDRAWAL
- Rapid decrease in order book depth
- Indicates uncertainty or impending price movement
- Often signals breakout in the withdrawal direction

### MARKET_MAKER_SHIFT
- Symmetric adjustment of both bid and ask liquidity
- Indicates market maker repositioning
- Signal to cancel pending orders

## Risk Management

1. **Position Sizing**: Never risk more than 30% of account on a single trade
2. **Stop Loss**: Always set immediately after entry
3. **Time Limits**: Strict time-based exits to avoid prolonged exposure
4. **Single Position**: Maximum one position at a time
5. **Breakeven Protection**: Move stop to breakeven once profitable

## Performance Expectations

- **Target Win Rate**: 60%+
- **Average Trade Duration**: 1-60 minutes
- **Risk:Reward**: 2:1
- **Daily Trade Count**: 10-50 depending on market conditions

## Monitoring

The strategy provides real-time updates on:
- Current market selection
- Pattern detections
- Order placements and fills
- Position P&L
- Exit decisions

## Safety Features

- Automatic order cancellation on conflicting signals
- Graceful shutdown on SIGINT (Ctrl+C)
- WebSocket reconnection handling
- MCP client error recovery
- Position size validation

## Requirements

- Node.js 18+
- Binance Futures account with API access
- Sufficient balance for margin requirements
- Stable internet connection for WebSocket streams