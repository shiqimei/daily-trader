#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import blessed from 'blessed';
import { BinanceOrderbookWS } from '../websocket/BinanceOrderbookWS';
import { OrderbookDynamics } from '../analysis/OrderbookDynamics';
import { CircularBuffer } from '../utils/CircularBuffer';
import { 
  OrderbookSnapshot, 
  TradingConfig, 
  TradingSignal,
  DynamicPattern,
  Derivatives,
  MarketState
} from '../types/orderbook';
import dotenv from 'dotenv';

dotenv.config();

interface DisplayData {
  orderbook: OrderbookSnapshot;
  derivatives: Derivatives;
  patterns: DynamicPattern[];
  signal: TradingSignal | null;
  stats: any;
  marketState: MarketState;
}

class OrderbookTUI {
  private screen: blessed.Widgets.Screen;
  private orderbookBox: blessed.Widgets.BoxElement;
  private velocityBox: blessed.Widgets.BoxElement;
  private patternsBox: blessed.Widgets.BoxElement;
  private signalBox: blessed.Widgets.BoxElement;
  private statsBox: blessed.Widgets.BoxElement;
  private logBox: blessed.Widgets.Log;
  
  private lastSignal: TradingSignal | null = null;
  private signalHistory: CircularBuffer<TradingSignal> = new CircularBuffer(10);
  
  constructor(private readonly symbol: string) {
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: `Orderbook Monitor - ${symbol}`,
      fullUnicode: true
    });
    
    // Create layout
    this.orderbookBox = blessed.box({
      label: ' Orderbook ',
      top: 0,
      left: 0,
      width: '50%',
      height: '40%',
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'cyan'
        },
        label: {
          fg: 'cyan'
        }
      },
      tags: true,
      scrollable: false
    });
    
    this.velocityBox = blessed.box({
      label: ' Velocity Metrics ',
      top: 0,
      left: '50%',
      width: '50%',
      height: '40%',
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'yellow'
        },
        label: {
          fg: 'yellow'
        }
      },
      tags: true
    });
    
    this.patternsBox = blessed.box({
      label: ' Detected Patterns ',
      top: '40%',
      left: 0,
      width: '50%',
      height: '30%',
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'magenta'
        },
        label: {
          fg: 'magenta'
        }
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true
    });
    
    this.signalBox = blessed.box({
      label: ' Trading Signal ',
      top: '40%',
      left: '50%',
      width: '50%',
      height: '30%',
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'green'
        },
        label: {
          fg: 'green'
        }
      },
      tags: true
    });
    
    this.statsBox = blessed.box({
      label: ' Statistics ',
      top: '70%',
      left: 0,
      width: '50%',
      height: '30%',
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'blue'
        },
        label: {
          fg: 'blue'
        }
      },
      tags: true
    });
    
    this.logBox = blessed.log({
      label: ' Log ',
      top: '70%',
      left: '50%',
      width: '50%',
      height: '30%',
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: 'gray'
        },
        label: {
          fg: 'gray'
        }
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true
    });
    
    // Add boxes to screen
    this.screen.append(this.orderbookBox);
    this.screen.append(this.velocityBox);
    this.screen.append(this.patternsBox);
    this.screen.append(this.signalBox);
    this.screen.append(this.statsBox);
    this.screen.append(this.logBox);
    
    // Handle exit
    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });
    
    // Initial render
    this.screen.render();
  }
  
  update(data: DisplayData): void {
    this.updateOrderbook(data.orderbook);
    this.updateVelocity(data.derivatives);
    this.updatePatterns(data.patterns);
    this.updateSignal(data.signal);
    this.updateStats(data.stats, data.marketState);
    
    this.screen.render();
  }
  
  private wsStatus: string = 'Connecting...';
  
  setWsStatus(status: string): void {
    this.wsStatus = status;
  }
  
  private updateOrderbook(orderbook: OrderbookSnapshot): void {
    const lines: string[] = [];
    
    // Header with status
    lines.push(`Time: ${new Date(orderbook.timestamp).toLocaleTimeString()} | Status: {${this.wsStatus === 'Connected' ? 'green' : 'yellow'}-fg}${this.wsStatus}{/}`);
    lines.push('');
    
    // Asks (reversed)
    const displayAsks = orderbook.asks.slice(0, 5).reverse();
    displayAsks.forEach(ask => {
      const sizeBar = this.getSizeBar(ask.size, 20);
      lines.push(`{red-fg}ASK ${ask.price.toFixed(2).padStart(10)} │ ${ask.size.toFixed(4).padStart(10)} ${sizeBar}{/}`);
    });
    
    // Spread
    if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const spread = orderbook.asks[0].price - orderbook.bids[0].price;
      const midPrice = (orderbook.asks[0].price + orderbook.bids[0].price) / 2;
      lines.push('{gray-fg}' + '─'.repeat(45) + '{/}');
      lines.push(`{white-fg}SPREAD: ${spread.toFixed(2)} │ MID: ${midPrice.toFixed(2)}{/}`);
      lines.push('{gray-fg}' + '─'.repeat(45) + '{/}');
    }
    
    // Bids
    orderbook.bids.slice(0, 5).forEach(bid => {
      const sizeBar = this.getSizeBar(bid.size, 20);
      lines.push(`{green-fg}BID ${bid.price.toFixed(2).padStart(10)} │ ${bid.size.toFixed(4).padStart(10)} ${sizeBar}{/}`);
    });
    
    this.orderbookBox.setContent(lines.join('\n'));
  }
  
  private updateVelocity(derivatives: Derivatives): void {
    const lines: string[] = [];
    
    const formatMetric = (name: string, value: number, unit: string, isPositive: boolean): string => {
      const color = isPositive ? '{green-fg}' : '{red-fg}';
      const formattedValue = Math.abs(value) < 0.01 ? value.toExponential(2) : value.toFixed(4);
      return `${name.padEnd(15)} │ ${color}${formattedValue.padStart(12)}{/} ${unit}`;
    };
    
    lines.push(formatMetric('Bid Velocity', derivatives.bidVelocity, 'units/s', derivatives.bidVelocity > 0));
    lines.push(formatMetric('Ask Velocity', derivatives.askVelocity, 'units/s', derivatives.askVelocity > 0));
    lines.push(formatMetric('Bid Rate', derivatives.bidRate * 100, '%/s', derivatives.bidRate > 0));
    lines.push(formatMetric('Ask Rate', derivatives.askRate * 100, '%/s', derivatives.askRate > 0));
    lines.push(formatMetric('Price Velocity', derivatives.priceVelocity, '$/s', derivatives.priceVelocity > 0));
    lines.push(formatMetric('Net Flow', derivatives.netFlow, 'units/s', derivatives.netFlow > 0));
    lines.push('');
    lines.push(formatMetric('Imbalance Ratio', derivatives.imbalanceRatio, '', Math.abs(derivatives.imbalanceRatio) < 2));
    
    this.velocityBox.setContent(lines.join('\n'));
  }
  
  private updatePatterns(patterns: DynamicPattern[]): void {
    const lines: string[] = [];
    
    if (patterns.length === 0) {
      lines.push('{gray-fg}No patterns detected{/}');
    } else {
      patterns.forEach(pattern => {
        const color = pattern.strength > 70 ? '{red-fg}' : 
                      pattern.strength > 50 ? '{yellow-fg}' : '{gray-fg}';
        lines.push(`${color}${pattern.type.padEnd(20)} │ ${pattern.side.padEnd(5)} │ ${pattern.strength}%{/}`);
        lines.push(`{gray-fg}  └─ ${pattern.description}{/}`);
        lines.push('');
      });
    }
    
    this.patternsBox.setContent(lines.join('\n'));
  }
  
  private updateSignal(signal: TradingSignal | null): void {
    if (signal) {
      this.lastSignal = signal;
      this.signalHistory.push(signal);
    }
    
    const lines: string[] = [];
    
    if (this.lastSignal) {
      const isActive = Date.now() - this.lastSignal.timestamp < this.lastSignal.expectedDuration * 1000;
      const signalColor = this.lastSignal.direction === 'LONG' ? '{green-fg}' : '{red-fg}';
      const statusColor = isActive ? '{green-fg}' : '{gray-fg}';
      
      lines.push(`${signalColor}Direction: ${this.lastSignal.direction}{/} │ Confidence: ${this.lastSignal.confidence}`);
      lines.push(`Strength: ${this.lastSignal.strength}% │ ${statusColor}Status: ${isActive ? 'ACTIVE' : 'EXPIRED'}{/}`);
      lines.push('');
      lines.push(`Entry: ${this.lastSignal.entryPrice.toFixed(2)}`);
      lines.push(`TP: ${this.lastSignal.takeProfit.toFixed(2)} │ SL: ${this.lastSignal.stopLoss.toFixed(2)}`);
      lines.push('');
      lines.push(`{cyan-fg}Reason:{/} ${this.lastSignal.reason}`);
    } else {
      lines.push('{gray-fg}No signal generated yet{/}');
    }
    
    this.signalBox.setContent(lines.join('\n'));
  }
  
  private updateStats(stats: any, marketState: MarketState): void {
    const lines: string[] = [];
    
    // Market state
    const regimeColor = marketState.regime === 'VOLATILE' ? '{red-fg}' :
                       marketState.regime === 'TRENDING' ? '{yellow-fg}' :
                       marketState.regime === 'QUIET' ? '{blue-fg}' : '{gray-fg}';
    
    lines.push(`Market Regime: ${regimeColor}${marketState.regime}{/}`);
    lines.push(`Trend Strength: ${marketState.trendStrength.toFixed(1)} bps`);
    lines.push(`Liquidity Score: ${marketState.liquidityScore.toFixed(0)}/100`);
    lines.push(`Volatility: ${marketState.isVolatile ? '{red-fg}HIGH{/}' : '{green-fg}NORMAL{/}'}`);
    lines.push('');
    
    // Stats
    lines.push(`Average Spread: ${stats.avgSpread.toFixed(4)}`);
    lines.push(`Velocity Imbalance: ${stats.velocityImbalance.toFixed(2)}`);
    
    if (stats.patternCounts && Object.keys(stats.patternCounts).length > 0) {
      lines.push('');
      lines.push('Pattern Counts:');
      Object.entries(stats.patternCounts).forEach(([type, count]) => {
        lines.push(`  ${type}: ${count}`);
      });
    }
    
    this.statsBox.setContent(lines.join('\n'));
  }
  
  private getSizeBar(size: number, maxWidth: number): string {
    const normalizedSize = Math.min(size / 10, 1);
    const barLength = Math.floor(normalizedSize * maxWidth);
    return '█'.repeat(barLength);
  }
  
  log(message: string, type: 'info' | 'warn' | 'error' = 'info'): void {
    const timestamp = new Date().toLocaleTimeString();
    let color = '';
    
    switch (type) {
      case 'warn':
        color = '{yellow-fg}';
        break;
      case 'error':
        color = '{red-fg}';
        break;
      default:
        color = '{white-fg}';
    }
    
    this.logBox.log(`${color}[${timestamp}] ${message}{/}`);
  }
  
  destroy(): void {
    this.screen.destroy();
  }
}

// Main CLI
const program = new Command();

program
  .name('orderbook-tui')
  .description('Real-time orderbook dynamics analyzer with TUI')
  .version('1.0.0');

program
  .argument('<symbol>', 'Trading symbol (e.g., BTCUSDC, ETHUSDC)')
  .option('--depth <number>', 'Orderbook depth levels', '10')
  .option('--window <number>', 'Analysis window size', '20')
  .option('--min-signal <number>', 'Minimum signal strength (0-100)', '60')
  .option('--update-speed <number>', 'Update speed in ms (100 or 1000)', '100')
  .action(async (symbol: string, options: any) => {
    // Initialize TUI
    const tui = new OrderbookTUI(symbol);
    tui.log(`Starting orderbook monitor for ${symbol}...`, 'info');
    
    try {
      // Fetch symbol info
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
      
      // Trading config
      const config: TradingConfig = {
        symbol,
        tickSize,
        minOrderSize,
        makerFee: 0.0002,
        takerFee: 0.0004,
        atrBps: 30, // Should fetch from API
        targetWinRate: 0.75
      };
      
      // Initialize components
      const dynamics = new OrderbookDynamics(
        config,
        parseInt(options.window),
        parseInt(options.depth),
        parseInt(options.minSignal)
      );
      
      // Snapshot buffer
      const snapshotBuffer = new CircularBuffer<OrderbookSnapshot>(300);
      let lastSnapshotTime = 0;
      let updateCount = 0;
      
      // Redirect console to TUI log
      const originalWarn = console.warn;
      const originalError = console.error;
      const originalLog = console.log;
      
      console.warn = (...args: any[]) => {
        tui.log(args.join(' '), 'warn');
      };
      
      console.error = (...args: any[]) => {
        tui.log(args.join(' '), 'error');
      };
      
      console.log = (...args: any[]) => {
        // Skip WebSocket connection messages
        const msg = args.join(' ');
        if (!msg.includes('WebSocket') && !msg.includes('Connecting')) {
          tui.log(msg, 'info');
        }
      };
      
      // Connect to WebSocket
      const ws = new BinanceOrderbookWS(
        symbol,
        (snapshot) => {
          const now = Date.now();
          
          // Store snapshot every 100ms
          if (now - lastSnapshotTime >= 100) {
            snapshotBuffer.push(snapshot);
            lastSnapshotTime = now;
            updateCount++;
            
            // Update dynamics
            const signal = dynamics.update(snapshot);
            const derivatives = dynamics.getCurrentDerivatives();
            const patterns = dynamics.getCurrentPatterns();
            const stats = dynamics.getStats();
            const marketState = dynamics.getMarketState();
            
            // Update display
            tui.update({
              orderbook: snapshot,
              derivatives,
              patterns,
              signal,
              stats,
              marketState
            });
            
            // Log important events
            if (signal) {
              tui.log(`NEW SIGNAL: ${signal.direction} @ ${signal.entryPrice.toFixed(2)} (${signal.confidence})`, 'warn');
            }
            
            // Log patterns periodically
            if (updateCount % 50 === 0 && patterns.length > 0) {
              const patternNames = patterns.map(p => p.type).join(', ');
              tui.log(`Active patterns: ${patternNames}`, 'info');
            }
          }
        },
        parseInt(options.depth),
        parseInt(options.updateSpeed),
        (status) => {
          tui.setWsStatus(status);
        }
      );
      
      tui.log('Connecting to Binance WebSocket...', 'info');
      await ws.connect();
      tui.log('Connected successfully', 'info');
      
      // Handle graceful shutdown
      process.on('SIGINT', () => {
        tui.log('Shutting down...', 'warn');
        ws.disconnect();
        // Restore console
        console.warn = originalWarn;
        console.error = originalError;
        console.log = originalLog;
        setTimeout(() => {
          tui.destroy();
          process.exit(0);
        }, 100);
      });
      
    } catch (error: any) {
      tui.log(`Error: ${error.message}`, 'error');
      setTimeout(() => {
        tui.destroy();
        process.exit(1);
      }, 2000);
    }
  });

program.parse();