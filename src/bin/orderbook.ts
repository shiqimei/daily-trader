#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import chalk from 'chalk';
import { BinanceOrderbookWS } from '../websocket/BinanceOrderbookWS';
import { OrderbookDynamics } from '../analysis/OrderbookDynamics';
import { CircularBuffer } from '../utils/CircularBuffer';
import { 
  OrderbookSnapshot, 
  TradingConfig, 
  TradingSignal,
  DynamicPattern,
  Derivatives
} from '../types/orderbook';
import dotenv from 'dotenv';

dotenv.config();

// Terminal display helper
class OrderbookDisplay {
  private lastSignal: TradingSignal | null = null;
  private signalHistory: CircularBuffer<TradingSignal> = new CircularBuffer(10);
  
  constructor(private readonly symbol: string) {}
  
  clear(): void {
    console.clear();
  }
  
  display(
    orderbook: OrderbookSnapshot,
    derivatives: Derivatives,
    patterns: DynamicPattern[],
    signal: TradingSignal | null,
    stats: any
  ): void {
    this.clear();
    
    // Header
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════════════'));
    console.log(chalk.cyan(`  Orderbook Dynamics Monitor - ${this.symbol}`));
    console.log(chalk.cyan(`  Time: ${new Date(orderbook.timestamp).toLocaleTimeString()}`));
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════════════'));
    console.log();
    
    // Orderbook display
    console.log(chalk.yellow('ORDERBOOK (Top 5 Levels):'));
    console.log(chalk.gray('─────────────────────────────────────────────────'));
    
    // Display asks in reverse order (highest first)
    const displayAsks = orderbook.asks.slice(0, 5).reverse();
    displayAsks.forEach(ask => {
      const sizeBar = this.getSizeBar(ask.size, 20);
      console.log(
        chalk.red(`ASK  ${ask.price.toFixed(2).padStart(10)} │ ${ask.size.toFixed(4).padStart(10)} ${sizeBar}`)
      );
    });
    
    // Spread
    if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const spread = orderbook.asks[0].price - orderbook.bids[0].price;
      const midPrice = (orderbook.asks[0].price + orderbook.bids[0].price) / 2;
      console.log(chalk.gray('─────────────────────────────────────────────────'));
      console.log(chalk.white(`     SPREAD: ${spread.toFixed(2)} │ MID: ${midPrice.toFixed(2)}`));
      console.log(chalk.gray('─────────────────────────────────────────────────'));
    }
    
    // Display bids
    orderbook.bids.slice(0, 5).forEach(bid => {
      const sizeBar = this.getSizeBar(bid.size, 20);
      console.log(
        chalk.green(`BID  ${bid.price.toFixed(2).padStart(10)} │ ${bid.size.toFixed(4).padStart(10)} ${sizeBar}`)
      );
    });
    
    console.log();
    
    // Derivatives
    console.log(chalk.yellow('VELOCITY METRICS:'));
    console.log(chalk.gray('─────────────────────────────────────────────────'));
    
    this.displayMetric('Bid Velocity', derivatives.bidVelocity, 'units/s', derivatives.bidVelocity > 0);
    this.displayMetric('Ask Velocity', derivatives.askVelocity, 'units/s', derivatives.askVelocity > 0);
    this.displayMetric('Bid Rate', derivatives.bidRate * 100, '%/s', derivatives.bidRate > 0);
    this.displayMetric('Ask Rate', derivatives.askRate * 100, '%/s', derivatives.askRate > 0);
    this.displayMetric('Price Velocity', derivatives.priceVelocity, '$/s', derivatives.priceVelocity > 0);
    this.displayMetric('Imbalance Ratio', derivatives.imbalanceRatio, '', Math.abs(derivatives.imbalanceRatio) < 2);
    
    console.log();
    
    // Patterns
    if (patterns.length > 0) {
      console.log(chalk.yellow('DETECTED PATTERNS:'));
      console.log(chalk.gray('─────────────────────────────────────────────────'));
      
      patterns.forEach(pattern => {
        const color = pattern.strength > 70 ? chalk.red : pattern.strength > 50 ? chalk.yellow : chalk.gray;
        console.log(
          color(`${pattern.type.padEnd(20)} │ ${pattern.side.padEnd(5)} │ Strength: ${pattern.strength}% │ ${pattern.description}`)
        );
      });
      
      console.log();
    }
    
    // Signal
    if (signal) {
      this.lastSignal = signal;
      this.signalHistory.push(signal);
    }
    
    if (this.lastSignal) {
      const isActive = Date.now() - this.lastSignal.timestamp < this.lastSignal.expectedDuration * 1000;
      const signalColor = this.lastSignal.direction === 'LONG' ? chalk.green : chalk.red;
      
      console.log(chalk.yellow('TRADING SIGNAL:'));
      console.log(chalk.gray('─────────────────────────────────────────────────'));
      
      console.log(signalColor.bold(`
  Direction: ${this.lastSignal.direction} │ Confidence: ${this.lastSignal.confidence} │ Strength: ${this.lastSignal.strength}%
  Entry: ${this.lastSignal.entryPrice.toFixed(2)} │ TP: ${this.lastSignal.takeProfit.toFixed(2)} │ SL: ${this.lastSignal.stopLoss.toFixed(2)}
  Reason: ${this.lastSignal.reason}
  Status: ${isActive ? 'ACTIVE' : 'EXPIRED'}
      `));
    }
    
    // Stats
    console.log();
    console.log(chalk.yellow('STATISTICS:'));
    console.log(chalk.gray('─────────────────────────────────────────────────'));
    console.log(chalk.white(`Average Spread: ${stats.avgSpread.toFixed(4)}`));
    
    if (stats.patternCounts && Object.keys(stats.patternCounts).length > 0) {
      console.log(chalk.white('\nPattern Counts:'));
      Object.entries(stats.patternCounts).forEach(([type, count]) => {
        console.log(chalk.gray(`  ${type}: ${count}`));
      });
    }
  }
  
  private getSizeBar(size: number, maxWidth: number): string {
    const normalizedSize = Math.min(size / 10, 1); // Normalize to 0-1 (assuming max size of 10)
    const barLength = Math.floor(normalizedSize * maxWidth);
    return chalk.gray('█'.repeat(barLength));
  }
  
  private displayMetric(name: string, value: number, unit: string, isPositive: boolean): void {
    const color = isPositive ? chalk.green : chalk.red;
    const formattedValue = Math.abs(value) < 0.01 ? value.toExponential(2) : value.toFixed(4);
    console.log(`${name.padEnd(15)} │ ${color(formattedValue.padStart(12))} ${unit}`);
  }
  
  displayError(error: string): void {
    console.error(chalk.red(`\nError: ${error}\n`));
  }
}

// Main CLI
const program = new Command();

program
  .name('orderbook')
  .description('Real-time orderbook dynamics analyzer')
  .version('1.0.0');

program
  .argument('<symbol>', 'Trading symbol (e.g., BTCUSDC, ETHUSDC)')
  .option('--depth <number>', 'Orderbook depth levels', '10')
  .option('--window <number>', 'Analysis window size', '20')
  .option('--min-signal <number>', 'Minimum signal strength (0-100)', '60')
  .option('--update-speed <number>', 'Update speed in ms (100 or 1000)', '100')
  .action(async (symbol: string, options: any) => {
    console.log(chalk.cyan(`Starting orderbook monitor for ${symbol}...`));
    
    try {
      // Fetch symbol info to get trading config
      const exchangeInfoResponse = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
      const exchangeInfo = await exchangeInfoResponse.json();
      const symbolInfo = exchangeInfo.symbols.find((s: any) => s.symbol === symbol);
      
      if (!symbolInfo) {
        throw new Error(`Symbol ${symbol} not found`);
      }
      
      const tickSize = parseFloat(
        symbolInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER')?.tickSize || '0.01'
      );
      
      const minOrderSize = parseFloat(
        symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE')?.minQty || '0.001'
      );
      
      // Get current ATR (you might want to fetch this from your API)
      const config: TradingConfig = {
        symbol,
        tickSize,
        minOrderSize,
        makerFee: 0.0002, // 0.02%
        takerFee: 0.0004, // 0.04%
        atrBps: 30, // Default 30 bps, should be fetched from API
        targetWinRate: 0.75
      };
      
      // Initialize components
      const display = new OrderbookDisplay(symbol);
      const dynamics = new OrderbookDynamics(
        config,
        parseInt(options.window),
        parseInt(options.depth),
        parseInt(options.minSignal)
      );
      
      // Snapshot buffer for 100ms intervals
      const snapshotBuffer = new CircularBuffer<OrderbookSnapshot>(300); // 30 seconds of data
      let lastSnapshotTime = 0;
      
      // Connect to WebSocket
      const ws = new BinanceOrderbookWS(
        symbol,
        (snapshot) => {
          const now = Date.now();
          
          // Store snapshot every 100ms
          if (now - lastSnapshotTime >= 100) {
            snapshotBuffer.push(snapshot);
            lastSnapshotTime = now;
            
            // Update dynamics
            const signal = dynamics.update(snapshot);
            const derivatives = dynamics.getCurrentDerivatives();
            const patterns = dynamics.getCurrentPatterns();
            const stats = dynamics.getStats();
            
            // Display
            display.display(snapshot, derivatives, patterns, signal, stats);
          }
        },
        parseInt(options.depth),
        parseInt(options.updateSpeed)
      );
      
      await ws.connect();
      
      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log(chalk.yellow('\n\nShutting down...'));
        ws.disconnect();
        process.exit(0);
      });
      
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

program.parse();