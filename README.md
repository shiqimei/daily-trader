# Daily Trader - Algorithmic Trading System

A comprehensive algorithmic trading system for Binance futures with multiple strategies including ICT & S/R confirmation trading and liquidity scalping.

## Features

- **ICT & S/R Trading System**: Systematic day trading using ICT concepts and classical support/resistance levels
- **Liquidity Scalping Strategy**: Real-time orderbook analysis to exploit short-term liquidity imbalances
- **Orderbook Analytics**: Advanced orderbook dynamics analysis with pattern detection
- **Risk Management**: Strict position sizing with 30% maximum risk per trade
- **MCP Integration**: Model Context Protocol support for AI-driven trading insights

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your Binance API credentials
   ```

3. **Run strategies**:
   ```bash
   # Liquidity Scalping
   npm run liquidity-scalping
   
   # Orderbook TUI
   pnpm orderbook
   
   # Trading System CLI
   npm run trading-system-cli
   ```

## Strategies

### Liquidity Scalping (v0.2.0)
- Identifies liquidity surges and withdrawals in real-time
- Places maker orders to capture spread
- Target: 60%+ win rate with 2:1 risk/reward
- Average trade duration: 1-60 minutes
- See [detailed documentation](docs/liquidity-scalping.md)

### ICT & S/R Confirmation
- Combines ICT concepts with classical support/resistance
- Focuses on high-probability setups
- Systematic entry and exit rules
- See [trading system documentation](src/prompts/tradingSystem.md)

## Documentation

- [Liquidity Scalping Strategy](docs/liquidity-scalping.md)
- [Orderbook CLI Guide](docs/orderbook-cli.md)
- [Trading System Rules](src/prompts/tradingSystem.md)

## Requirements

- Node.js 18+
- Binance Futures account with API access
- Stable internet connection for WebSocket streams

## Version History

- v1.1.0: Added liquidity scalping strategy
- v1.0.0: Initial release with ICT & S/R trading system
