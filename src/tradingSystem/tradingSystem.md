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
2. GET klines
    ☐ mcp__binance__get_klines → Retrieve 5m, 15m, 4H, 1D timeframes for BTCUSDC & ETHUSDC
3. ICT Analysis
    - Market Structure: [BULLISH/BEARISH] - [BOS/CHoCH status]
    - Liquidity Pools: [SSL @price / BSL @price]
    - Order Blocks: [Bullish OB @price / Bearish OB @price]
    - Imbalances: [FVG @price range]
    - Confirmation: [Type of smart money confirmation]
4. Trading Setups
    - Trade with trend direction only (Long/Short)
    ☐ Setup A: Liquidity Sweep (SSL/BSL)
    ☐ Setup B: Fair Value Gap (FVG) present
    - Confirmation: Rejection wick formed at Support/Resistance (minimum 2 touches on 4H chart) after pullback
    ☐ Open position when: (Setup A OR Setup B) AND Confirmation AND Trend alignment
5. Position Management
    ☐ Entry → Set SL beyond structure/liquidity
    ☐ 1R → Close 50% position + Move stop loss to breakeven
    ☐ 2R → Close additional 50% + Trail stop at order blocks or market structure breaks
    ☐ Exit immediately if profit retracement exceeds 50% from previous high
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
Balance: [total] [available]
Decisions: [market/ICT analysis, key insights, decisions made]
Positions:
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
```
