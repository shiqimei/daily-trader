#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import blessed from 'blessed';
import { BinanceWebsocket } from '../websocket/BinanceWebsocket';
import { OrderFlowImbalance } from '../analysis/OrderFlowImbalance';
import { CircularBuffer } from '../utils/CircularBuffer';
import { OrderbookSnapshot } from '../types/orderbook';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

interface ImbalanceHistory {
  timestamp: number;
  priceImpactImbalance: number;
  orderbookPressure: number;
  microstructureFlowImbalance: number;
  flowToxicity: number;
  flowDirection: number;
  signalType: 'SETUP' | 'CANCEL' | 'ADJUST' | null;
  askPrice?: number;
  bidPrice?: number;
}

class OrderFlowTUI {
  private screen: blessed.Widgets.Screen;
  private orderbookBox: blessed.Widgets.BoxElement;
  private metricsBox: blessed.Widgets.BoxElement;
  private flowBox: blessed.Widgets.BoxElement;
  private signalBox: blessed.Widgets.BoxElement;
  private tradesBox: blessed.Widgets.Log;
  private historyBox: blessed.Widgets.BoxElement;
  
  private orderFlowAnalyzer: OrderFlowImbalance;
  private imbalanceHistory: CircularBuffer<ImbalanceHistory> = new CircularBuffer(50);
  private recentTrades: CircularBuffer<any> = new CircularBuffer(100);
  private tickSize: number = 0.0001;
  private pricePrecision: number = 4;
  private lastMetrics: any = null;
  private lastSignal: any = null;
  
  constructor(
    private readonly symbol: string,
    private readonly atrValue: number,
    private readonly avgTradeSize: number,
    private readonly avgSpread: number
  ) {
    // Adjust precision based on symbol
    if (symbol.includes('BTC')) {
      this.tickSize = 0.1;
      this.pricePrecision = 1;
    } else if (symbol.includes('SHIB')) {
      this.tickSize = 0.0000001;
      this.pricePrecision = 7;
    }
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: `Order Flow Monitor - ${symbol}`,
      fullUnicode: true,
      forceUnicode: true,
      tags: true
    });
    
    // Create layout
    this.orderbookBox = blessed.box({
      label: ' Order Book ',
      left: 0,
      top: 0,
      width: '30%',
      height: '50%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: 'cyan' }
      }
    });
    
    this.metricsBox = blessed.box({
      label: ' Imbalance Metrics ',
      left: '30%',
      top: 0,
      width: '40%',
      height: '50%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      wrap: true,
      style: {
        border: { fg: 'yellow' }
      }
    });
    
    this.flowBox = blessed.box({
      label: ' Flow Analysis ',
      left: '70%',
      top: 0,
      width: '30%',
      height: '50%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: 'magenta' }
      }
    });
    
    this.signalBox = blessed.box({
      label: ' Signals ',
      left: 0,
      top: '50%',
      width: '30%',
      height: '25%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: 'green' }
      }
    });
    
    this.tradesBox = blessed.log({
      label: ' Recent Trades ',
      left: '30%',
      top: '50%',
      width: '40%',
      height: '25%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: 'blue' }
      }
    });
    
    this.historyBox = blessed.box({
      label: ' Metric History ',
      left: '70%',
      top: '50%',
      width: '30%',
      height: '25%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: 'white' }
      }
    });
    
    // Status bar
    const statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: {
        fg: 'white',
        bg: 'blue'
      }
    });
    
    statusBar.setContent(` ${symbol} | ATR: ${atrValue} | Press 'q' to quit | 'r' to reset history `);
    
    // Add all boxes to screen
    this.screen.append(this.orderbookBox);
    this.screen.append(this.metricsBox);
    this.screen.append(this.flowBox);
    this.screen.append(this.signalBox);
    this.screen.append(this.tradesBox);
    this.screen.append(this.historyBox);
    this.screen.append(statusBar);
    
    // Set up key bindings
    this.screen.key(['q', 'C-c'], () => {
      process.exit(0);
    });
    
    this.screen.key(['r'], () => {
      this.imbalanceHistory = new CircularBuffer(50);
      this.recentTrades = new CircularBuffer(100);
      this.screen.render();
    });
    
    // Initialize OrderFlowImbalance analyzer
    this.orderFlowAnalyzer = new OrderFlowImbalance(
      this.tickSize,
      this.atrValue,
      this.avgTradeSize,
      this.avgSpread
    );
  }
  
  private formatOrderbook(orderbook: OrderbookSnapshot): string {
    const lines: string[] = [];
    const depth = 10;
    
    // Header
    lines.push(`  Price      Size     Total`);
    lines.push('─'.repeat(30));
    
    // Asks (reverse order for display)
    const asks = orderbook.asks.slice(0, depth).reverse();
    asks.forEach(level => {
      const total = orderbook.asks
        .filter(a => a.price <= level.price)
        .reduce((sum, a) => sum + a.size, 0);
      lines.push(`{red-fg}${level.price.toFixed(this.pricePrecision).padStart(8)} ${level.size.toFixed(2).padStart(8)} ${total.toFixed(2).padStart(8)}{/red-fg}`);
    });
    
    // Spread
    if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const spread = orderbook.asks[0].price - orderbook.bids[0].price;
      const spreadBps = (spread / orderbook.bids[0].price) * 10000;
      lines.push('─'.repeat(30));
      lines.push(`{cyan-fg}Spread: ${spread.toFixed(this.pricePrecision)} (${spreadBps.toFixed(1)}bps){/cyan-fg}`);
      lines.push('─'.repeat(30));
    }
    
    // Bids
    const bids = orderbook.bids.slice(0, depth);
    bids.forEach(level => {
      const total = orderbook.bids
        .filter(b => b.price >= level.price)
        .reduce((sum, b) => sum + b.size, 0);
      lines.push(`{green-fg}${level.price.toFixed(this.pricePrecision).padStart(8)} ${level.size.toFixed(2).padStart(8)} ${total.toFixed(2).padStart(8)}{/green-fg}`);
    });
    
    return lines.join('\n');
  }
  
  private formatMetrics(metrics: any): string {
    const lines: string[] = [];
    
    if (!metrics || typeof metrics.priceImpactImbalance === 'undefined') {
      return lines.join('\n');
    }
    
    lines.push('{bold}Price Impact Imbalance (PII):{/bold}');
    lines.push(this.createBar(metrics.priceImpactImbalance, -1, 1, 'Sell Pressure', 'Buy Pressure'));
    lines.push('Value: ' + metrics.priceImpactImbalance.toFixed(3));
    lines.push('');
    
    lines.push('{bold}Orderbook Pressure (OBP):{/bold}');
    lines.push(this.createBar(metrics.orderbookPressure, -1, 1, 'Ask Resistance', 'Bid Resistance'));
    lines.push('Value: ' + metrics.orderbookPressure.toFixed(3));
    lines.push('');
    
    lines.push('{bold}Microstructure Flow Imbalance (MFI):{/bold}');
    lines.push(this.createBar(metrics.microstructureFlowImbalance, -1, 1, 'Down Pressure', 'Up Pressure'));
    lines.push('Value: ' + metrics.microstructureFlowImbalance.toFixed(3));
    lines.push('');
    
    lines.push('{bold}Flow Toxicity (FT):{/bold}');
    lines.push(this.createBar(metrics.flowToxicity, 0, 1, 'Safe', 'Toxic'));
    lines.push('Value: ' + metrics.flowToxicity.toFixed(3));
    lines.push('');
    
    lines.push('{bold}Fake Walls:{/bold}');
    lines.push('Bid Wall: ' + (metrics.fakeBidWall ? '{red-fg}YES{/red-fg}' : '{green-fg}NO{/green-fg}'));
    lines.push('Ask Wall: ' + (metrics.fakeAskWall ? '{red-fg}YES{/red-fg}' : '{green-fg}NO{/green-fg}'));
    
    return lines.join('\n');
  }
  
  private createBar(value: number, min: number, max: number, leftLabel: string, rightLabel: string): string {
    const width = 30;
    const normalized = (value - min) / (max - min);
    const position = Math.round(normalized * width);
    const bar = '─'.repeat(width);
    const pointer = '▼';
    
    let result = leftLabel.padEnd(12) + ' ';
    for (let i = 0; i < width; i++) {
      if (i === position) {
        result += '{yellow-fg}' + pointer + '{/yellow-fg}';
      } else if (i === Math.round(width / 2)) {
        result += '│';
      } else {
        result += bar[i];
      }
    }
    result += ' ' + rightLabel;
    
    return result;
  }
  
  private formatFlowAnalysis(trades: any[]): string {
    const lines: string[] = [];
    const recentTrades = trades.slice(-20);
    
    // Trade flow summary
    let buyVolume = 0;
    let sellVolume = 0;
    let buyCount = 0;
    let sellCount = 0;
    let largeBuyVolume = 0;
    let largeSellVolume = 0;
    
    recentTrades.forEach(trade => {
      if (!trade.isBuyerMaker) { // Market buy
        buyVolume += trade.quantity;
        buyCount++;
        if (trade.quantity > this.avgTradeSize * 2) {
          largeBuyVolume += trade.quantity;
        }
      } else { // Market sell
        sellVolume += trade.quantity;
        sellCount++;
        if (trade.quantity > this.avgTradeSize * 2) {
          largeSellVolume += trade.quantity;
        }
      }
    });
    
    const totalVolume = buyVolume + sellVolume;
    const buyRatio = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;
    const sellRatio = totalVolume > 0 ? (sellVolume / totalVolume) * 100 : 50;
    
    lines.push(`{bold}Trade Flow Summary:{/bold}`);
    lines.push(`Buy Volume:  ${buyVolume.toFixed(2)} (${buyRatio.toFixed(1)}%)`);
    lines.push(`Sell Volume: ${sellVolume.toFixed(2)} (${sellRatio.toFixed(1)}%)`);
    lines.push(`Buy Count:   ${buyCount}`);
    lines.push(`Sell Count:  ${sellCount}`);
    lines.push('');
    
    lines.push(`{bold}Large Trade Analysis:{/bold}`);
    lines.push(`Large Buy Volume:  ${largeBuyVolume.toFixed(2)}`);
    lines.push(`Large Sell Volume: ${largeSellVolume.toFixed(2)}`);
    lines.push(`Avg Trade Size:    ${this.avgTradeSize.toFixed(2)}`);
    lines.push('');
    
    // Trade size distribution
    lines.push(`{bold}Recent Trade Sizes:{/bold}`);
    const sizes = recentTrades.map(t => t.quantity).sort((a, b) => b - a);
    const p95 = sizes[Math.floor(sizes.length * 0.05)] || 0;
    const p50 = sizes[Math.floor(sizes.length * 0.5)] || 0;
    const p5 = sizes[Math.floor(sizes.length * 0.95)] || 0;
    
    lines.push(`95th percentile: ${p95.toFixed(2)}`);
    lines.push(`Median:          ${p50.toFixed(2)}`);
    lines.push(`5th percentile:  ${p5.toFixed(2)}`);
    
    return lines.join('\n');
  }
  
  private formatSignals(signal: any): string {
    const lines: string[] = [];
    
    if (!signal || !signal.metrics) {
      // Still show the waiting state even without metrics
      lines.push('No active signal');
      lines.push('');
      lines.push('{bold}Waiting for MM conditions:{/bold}');
      lines.push('• Monitoring flow toxicity');
      lines.push('• Tracking order imbalances');
      lines.push('• Detecting sweep patterns');
      return lines.join('\n');
    }
    
    if (signal.type === 'SETUP') {
      lines.push(`{bold}{green-fg}═══ MARKET MAKING SETUP ═══{/green-fg}{/bold}`);
      lines.push(`Ask: ${signal.askPrice?.toFixed(this.pricePrecision) || 'N/A'}`);
      lines.push(`Bid: ${signal.bidPrice?.toFixed(this.pricePrecision) || 'N/A'}`);
      lines.push('');
      lines.push(`{bold}Reason:{/bold} ${signal.reason || 'Unknown'}`);
      lines.push('');
      lines.push(`{bold}Market Conditions:{/bold}`);
      lines.push(`PII: ${signal.metrics.priceImpactImbalance.toFixed(3)}`);
      lines.push(`OBP: ${signal.metrics.orderbookPressure.toFixed(3)}`);
      lines.push(`MFI: ${signal.metrics.microstructureFlowImbalance.toFixed(3)}`);
      lines.push(`Toxicity: ${signal.metrics.flowToxicity.toFixed(3)}`);
    } else if (signal.type === 'CANCEL') {
      lines.push(`{bold}{red-fg}═══ CANCEL ORDERS ═══{/red-fg}{/bold}`);
      lines.push('');
      lines.push(`{bold}Reason:{/bold} ${signal.reason || 'Unknown'}`);
      lines.push('');
      lines.push(`{bold}Risk Metrics:{/bold}`);
      lines.push(`Toxicity: ${signal.metrics.flowToxicity.toFixed(3)}`);
      lines.push(`|MFI|: ${Math.abs(signal.metrics.microstructureFlowImbalance).toFixed(3)}`);
    } else if (signal.metrics) {
      // Show current metric status even without a signal
      lines.push('No active signal');
      lines.push('');
      lines.push('{bold}Current Conditions:{/bold}');
      lines.push(`PII: ${signal.metrics.priceImpactImbalance?.toFixed(3) || 'N/A'}`);
      lines.push(`|MFI|: ${typeof signal.metrics.microstructureFlowImbalance === 'number' ? Math.abs(signal.metrics.microstructureFlowImbalance).toFixed(3) : 'N/A'}`);
      lines.push(`Toxicity: ${signal.metrics.flowToxicity?.toFixed(3) || 'N/A'}`);
      lines.push(`Flow Dir: ${signal.metrics.flowDirection?.toFixed(3) || 'N/A'}`);
      lines.push(`Fake Walls: Bid=${signal.metrics.fakeBidWall ? 'Y' : 'N'}, Ask=${signal.metrics.fakeAskWall ? 'Y' : 'N'}`);
    } else {
      // No metrics available
      lines.push('No active signal');
      lines.push('');
      lines.push('{bold}Market Making Mode:{/bold}');
      lines.push('• Monitoring order flow');
      lines.push('• Waiting for opportunities');
      lines.push('• Risk management active');
    }
    
    return lines.join('\n');
  }
  
  private formatHistory(): string {
    const lines: string[] = [];
    const history = this.imbalanceHistory.getAll();
    
    lines.push(`{bold}Recent Signals:{/bold}`);
    const signals = history.filter(h => h.signalType !== null).slice(-5);
    
    if (signals.length === 0) {
      lines.push('No recent signals');
    } else {
      signals.forEach(s => {
        const time = new Date(s.timestamp).toLocaleTimeString();
        const color = s.signalType === 'SETUP' ? 'green' : s.signalType === 'CANCEL' ? 'red' : 'yellow';
        let signalText = `${time} - {${color}-fg}${s.signalType}{/${color}-fg}`;
        
        // Add prices for SETUP signals
        if (s.signalType === 'SETUP' && s.bidPrice && s.askPrice) {
          signalText += ` B:${s.bidPrice.toFixed(this.pricePrecision)} A:${s.askPrice.toFixed(this.pricePrecision)}`;
        }
        
        lines.push(signalText);
      });
    }
    
    lines.push('');
    lines.push(`{bold}Metric Trends:{/bold}`);
    
    if (history.length >= 10) {
      const recent = history.slice(-10);
      const avgPII = recent.reduce((sum, h) => sum + h.priceImpactImbalance, 0) / recent.length;
      const avgToxicity = recent.reduce((sum, h) => sum + h.flowToxicity, 0) / recent.length;
      const avgFlow = recent.reduce((sum, h) => sum + h.flowDirection, 0) / recent.length;
      
      lines.push(`Avg PII:      ${avgPII.toFixed(3)}`);
      lines.push(`Avg Toxicity: ${avgToxicity.toFixed(3)}`);
      lines.push(`Avg Flow Dir: ${avgFlow.toFixed(3)}`);
    }
    
    return lines.join('\n');
  }
  
  update(orderbook: OrderbookSnapshot, trade?: any): void {
    try {
      // Add trade to analyzer if provided
      if (trade) {
        this.orderFlowAnalyzer.addTrade(
          trade.price,
          trade.quantity,
          trade.isBuyerMaker,
          trade.timestamp
        );
        this.recentTrades.push(trade);
        
        // Update trades box
        const tradeStr = `${new Date(trade.timestamp).toLocaleTimeString()} ${
          trade.isBuyerMaker ? 'SELL' : 'BUY '
        } ${trade.quantity.toFixed(2)} @ ${trade.price.toFixed(this.pricePrecision)}`;
        this.tradesBox.log(trade.isBuyerMaker ? `{red-fg}${tradeStr}{/red-fg}` : `{green-fg}${tradeStr}{/green-fg}`);
      }
      
      // Update analyzer and get signal
      const signal = this.orderFlowAnalyzer.update(orderbook);
      
      // Store history and update last known good data ONLY if we have valid metrics
      if (signal && signal.metrics && typeof signal.metrics.priceImpactImbalance === 'number') {
        this.lastMetrics = signal.metrics;
        this.lastSignal = signal;
        
        this.imbalanceHistory.push({
          timestamp: Date.now(),
          priceImpactImbalance: signal.metrics.priceImpactImbalance,
          orderbookPressure: signal.metrics.orderbookPressure,
          microstructureFlowImbalance: signal.metrics.microstructureFlowImbalance,
          flowToxicity: signal.metrics.flowToxicity,
          flowDirection: signal.metrics.flowDirection,
          signalType: signal.type,
          askPrice: signal.askPrice,
          bidPrice: signal.bidPrice
        });
      }
      
      // Update display boxes - always use last known good data
      this.orderbookBox.setContent(this.formatOrderbook(orderbook));
      
      // Use current data if available, otherwise use last known good data
      const hasValidCurrentMetrics = signal && signal.metrics && typeof signal.metrics.priceImpactImbalance === 'number';
      const metricsToDisplay = hasValidCurrentMetrics ? signal.metrics : this.lastMetrics;
      const signalToDisplay = hasValidCurrentMetrics ? signal : this.lastSignal;
      
      // Always show metrics if we have any data (current or last)
      if (metricsToDisplay) {
        this.metricsBox.setContent(this.formatMetrics(metricsToDisplay));
      }
      
      if (signalToDisplay) {
        this.signalBox.setContent(this.formatSignals(signalToDisplay));
      } else {
        this.signalBox.setContent('No active signal\n\n{bold}Waiting for conditions:{/bold}\n• 4+ conditions must be met\n• Low flow toxicity\n• Imbalance mismatch');
      }
      
      this.flowBox.setContent(this.formatFlowAnalysis(this.recentTrades.getAll()));
      this.historyBox.setContent(this.formatHistory());
      
      // Render screen
      this.screen.render();
    } catch (error) {
      console.error('Error updating display:', error);
    }
  }
  
  start(): void {
    this.screen.render();
  }
}

async function main() {
  const program = new Command();
  
  program
    .name('orderflow')
    .description('Order Flow Imbalance visualization tool for Binance futures')
    .version('0.1.0')
    .argument('[symbol]', 'Trading symbol (e.g., BTCUSDT)')
    .option('-s, --symbol <symbol>', 'Trading symbol (alternative to positional argument)')
    .option('-a, --atr <number>', 'ATR value', parseFloat, 50.0)
    .option('-t, --avg-trade <number>', 'Average trade size', parseFloat, 0.5)
    .option('-p, --avg-spread <number>', 'Average spread', parseFloat, 0.1)
    .option('-u, --update-speed <ms>', 'Update speed in milliseconds', parseInt, '100')
    .option('-d, --depth <levels>', 'Orderbook depth levels', parseInt, '20');
  
  program.parse();
  const options = program.opts();
  const args = program.args;
  
  // Get symbol from argument or option
  const symbol = args[0] || options.symbol;
  if (!symbol) {
    console.error('Error: Symbol is required');
    console.error('Usage: pnpm orderflow BTCUSDT');
    process.exit(1);
  }
  
  // Create TUI
  const tui = new OrderFlowTUI(
    symbol.toUpperCase(),
    options.atr,
    options.avgTrade,
    options.avgSpread
  );
  
  // Connect to websocket
  const ws = new BinanceWebsocket(
    symbol.toUpperCase(),
    (snapshot) => tui.update(snapshot),
    parseInt(options.depth),
    parseInt(options.updateSpeed)
  );
  
  // Set up trade callback
  ws.onTrade = (trade) => tui.update(ws.getOrderbook(), trade);
  
  // Start
  await ws.connect();
  tui.start();
}

main().catch(console.error);