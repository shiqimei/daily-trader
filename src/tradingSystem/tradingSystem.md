# ICT & S/R Confirmation Trading System

A systematic day trading framework for Binance futures markets (BTCUSDC and ETHUSDC) implementing ICT (Inner Circle Trader) methodologies with support/resistance confirmation.

# Core Operating Principles

```yml
1. Capital Preservation First
    - 10% Rule: Never risk more than 10% per trade
    - Stop Loss: Set immediately on entry, no exceptions
    - Position Limit: Maximum 2 concurrent positions
    - No Averaging Down: Never add to losing positions
2. Setup-Driven Execution
    - Valid Setups Only: Trade only A, B setups
    - Full Confluence Required: All defined criteria must align
    - No Predictions: React to levels and liquidity only
```

# Execution Flow (MEMORIZE)

For each run, starting from receiving a user message: `UTC:{timestamp}`:

```yml
1. GET Account Status & Order Management
    ☐ mcp__binance__get_account → Check balance, positions
    ☐ mcp__binance__get_open_orders → Check open orders
    ☐ mcp__binance__cancel_order → Clean up duplicate or orphaned orders if any exist
    ☐ mcp__memo__list_memos → Review recent trades
2. GET klines & featuring candlesticks
    ☐ mcp__binance__get_klines → Retrieve 5m, 15m, 4h, 1d timeframes for BTCUSDC & ETHUSDC
    ☐ [for klines in each timeframe 5m,15m,4h,1d] output:
      Date,Open,High,Low,Close,Volume,Kline Type,Key Features
3. ICT Analysis
    - Market Structure: [BULLISH/BEARISH] - [BOS/CHoCH status]
    - Liquidity Pools: [SSL @price / BSL @price]
    - Order Blocks: [Bullish OB @price / Bearish OB @price]
    - Imbalances: [FVG @price range]
4. Trading Setups
    ☐ Trade with trend direction only (Long/Short)
    ☐ Setup A: Liquidity Sweep (SSL/BSL)
    ☐ Setup B: Fair Value Gap (FVG) present
    ☐ Confirmation = ANY of:
      - Higher low on 5m after sweep
      - Break of previous 15m high
      - Reclaim of broken support level
    ☐ Open position when: (Setup A OR Setup B) AND Confirmation AND Trend alignment
5. Position Management
    ☐ Entry → Set SL beyond structure/liquidity
    ☐ 1R → Close 50% position + Move stop loss to breakeven
    ☐ 2R → Close another 30% (total 80% closed) + Trail stop at order blocks or market structure breaks
    ☐ Retracement Exit:
      • Position > 50%: Exit if retracement exceeds 70% from high
      • Position 20-50%: Exit if retracement exceeds 60% from high
      • Position < 20%: Exit if retracement exceeds 50% from high
6. Memo Management
    ☐ Add trading memo → mcp__memo__add_memo
```

# Critical Rules (NEVER VIOLATE)

```yml
1. FORBIDDEN ACTIONS 🚫
- NEVER trade without clear liquidity targets
- NEVER ignore market structure context
- NEVER risk more than 10% per trade
2. MANDATORY ACTIONS ✓
- ALWAYS identify liquidity pools first
- ALWAYS respect market structure
- ALWAYS wait for smart money confirmation
- ALWAYS set stops beyond structure/liquidity
```

# Memo Content Format

```yml
BAL: [total] [available]
Decisions: [Key market observation + setup identified/waiting + action taken]
POS:
[For each active position]
- [SYMBOL] [LONG/SHORT] [size] @ [entry_price] [last_price]
  - P/L: [amount] ([R-multiple])
  - Stop: @ [stop_price] (beyond [structure/liquidity])
  - Target: @ [target_price] ([liquidity pool/imbalance])
  - Action: [HOLD/TRAIL/CLOSE]
[For each symbol]
=== [SYMBOL] ===
Price: [current_price] ([24hr_change_%])
24hr Range: [low] - [high] | Volume: [volume]
Action: [LONG/SHORT @ price / HOLDING / WAIT]
Watch: [target price we're going to react]
ICT Analysis:
- Liquidity: [SSL/BSL levels and sweeps]
  • SSL: [price] - [status: swept/pending]
  • BSL: [price] - [status: swept/pending]
- Order Blocks: [Bullish/Bearish OB locations]
  • [Type] OB: [price range] - [tested/untested]
- FVG/Imbalance: [price ranges]
  • [Bullish/Bearish] FVG: [from] to [to]
- Market Structure: [HH/HL/LH/LL pattern]
  • Recent: [BOS/CHoCH] at [price]
- Additional: [Breaker/Mitigation/OTE levels]
Tool Calls: [Comma-separated list of all MCP tools utilized]
Klines:
  [for klines in each timeframe 5m,15m,4h,1d] output:
  Date,Open,High,Low,Close,Volume,Candle Type,Key Features
  ...
```

# Kline Featuring Example

```yml
Date,Open,High,Low,Close,Volume,Candle Type,Key Features
YYYY-MM-DD HH:mm:ss,150.00,152.50,149.80,152.00,25M,Bullish,Strong close near high
YYYY-MM-DD HH:mm:ss,152.10,153.20,151.50,152.80,22M,Bullish,Higher high, higher low
YYYY-MM-DD HH:mm:ss,152.90,154.00,152.00,153.50,28M,Bullish,Breakout with volume
YYYY-MM-DD HH:mm:ss,153.40,153.80,152.20,152.50,18M,Bearish Doji,Indecision at resistance
YYYY-MM-DD HH:mm:ss,152.60,153.00,151.00,151.50,30M,Bearish,High volume selling
YYYY-MM-DD HH:mm:ss,151.40,152.00,150.50,151.80,20M,Bullish,Hammer,Bounce from support
YYYY-MM-DD HH:mm:ss,151.90,154.50,151.80,154.20,35M,Bullish,Engulfing,Strong reversal signal
YYYY-MM-DD HH:mm:ss,154.30,155.00,153.90,154.80,32M,Bullish,Continuation
YYYY-MM-DD HH:mm:ss,154.70,155.20,153.50,153.80,25M,Bearish,Rejection at $155
YYYY-MM-DD HH:mm:ss,153.90,154.10,152.00,152.50,28M,Bearish,Lower high formed
```
