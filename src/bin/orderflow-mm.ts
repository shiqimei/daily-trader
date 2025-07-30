#!/usr/bin/env -S npx tsx
/**
 * Order Flow Market Making Tool v1.0.0
 * 
 * Combines order flow visualization with automated market making.
 * Uses imbalance signals to place strategic market orders.
 */

import { Command } from 'commander';
import blessed from 'blessed';
import { BinanceWebsocket } from '../websocket/BinanceWebsocket';
import { OrderFlowImbalance } from '../analysis/OrderFlowImbalance';
import { CircularBuffer } from '../utils/CircularBuffer';
import { OrderbookSnapshot } from '../types/orderbook';
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { BinanceUserDataWS, AccountUpdate, OrderUpdate } from '../websocket/BinanceUserDataWS';
import { ExponentialBackoff } from '../utils/ExponentialBackoff';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

// Trading states
type TradingState = 'IDLE' | 'WATCHING' | 'ORDER_PLACED' | 'POSITION_ACTIVE' | 'CLOSING' | 'ERROR';

interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  size: number;
  entryTime: number;
  slOrderId?: string;
  slPrice: number;
  unrealizedPnl?: number;
}

interface MarkerOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  status: 'NEW' | 'FILLED' | 'CANCELED';
}

interface TradingStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  lastTradeTime: number;
}

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

class OrderFlowMMTUI {
  private screen: blessed.Widgets.Screen;
  private orderbookBox: blessed.Widgets.BoxElement;
  private metricsBox: blessed.Widgets.BoxElement;
  private flowBox: blessed.Widgets.BoxElement;
  private signalBox: blessed.Widgets.BoxElement;
  private tradesBox: blessed.Widgets.Log;
  private historyBox: blessed.Widgets.BoxElement;
  private tradingBox: blessed.Widgets.BoxElement; // New trading status box
  
  private orderFlowAnalyzer: OrderFlowImbalance;
  private imbalanceHistory: CircularBuffer<ImbalanceHistory> = new CircularBuffer(50);
  private recentTrades: CircularBuffer<any> = new CircularBuffer(100);
  private tickSize: number = 0.0001;
  private pricePrecision: number = 4;
  private lastMetrics: any = null;
  private lastSignal: any = null;
  
  // Trading components
  private mcpClient: Client | null = null;
  private userDataWS: BinanceUserDataWS | null = null;
  private tradingState: TradingState = 'IDLE';
  private position: Position | null = null;
  private markerOrder: MarkerOrder | null = null;
  private accountBalance: number = 0;
  private tradingStats: TradingStats = {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnl: 0,
    lastTradeTime: 0
  };
  private backoff: ExponentialBackoff;
  private minOrderSize: number = 0.001;
  private stepSize: number = 0.001;
  private tradingEnabled: boolean = false;
  
  constructor(
    private readonly symbol: string,
    private readonly atrValue: number,
    private readonly avgTradeSize: number,
    private readonly avgSpread: number,
    private readonly enableTrading: boolean = false
  ) {
    // Adjust precision based on symbol
    if (symbol.includes('BTC')) {
      this.tickSize = 0.1;
      this.pricePrecision = 1;
    } else if (symbol.includes('SHIB')) {
      this.tickSize = 0.0000001;
      this.pricePrecision = 7;
    }
    
    this.tradingEnabled = enableTrading;
    this.backoff = new ExponentialBackoff(3000, 60000, 2);
    
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: `Order Flow MM - ${symbol}`,
      fullUnicode: true,
      forceUnicode: true,
      tags: true
    });
    
    // Create layout (modified to include trading box)
    this.orderbookBox = blessed.box({
      label: ' Order Book ',
      left: 0,
      top: 0,
      width: '25%',
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
      left: '25%',
      top: 0,
      width: '35%',
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
      left: '60%',
      top: 0,
      width: '20%',
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
    
    // New trading status box
    this.tradingBox = blessed.box({
      label: ' Trading Status ',
      left: '80%',
      top: 0,
      width: '20%',
      height: '50%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: this.tradingEnabled ? 'green' : 'red' }
      }
    });
    
    this.signalBox = blessed.box({
      label: ' Signals ',
      left: 0,
      top: '50%',
      width: '25%',
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
      left: '25%',
      top: '50%',
      width: '35%',
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
      left: '60%',
      top: '50%',
      width: '40%',
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
    
    const tradingStatus = this.tradingEnabled ? 'LIVE TRADING' : 'VIEW ONLY';
    statusBar.setContent(` ${symbol} | ATR: ${atrValue} | Mode: ${tradingStatus} | 'q' quit | 'r' reset | 't' toggle trading `);
    
    // Add all boxes to screen
    this.screen.append(this.orderbookBox);
    this.screen.append(this.metricsBox);
    this.screen.append(this.flowBox);
    this.screen.append(this.tradingBox);
    this.screen.append(this.signalBox);
    this.screen.append(this.tradesBox);
    this.screen.append(this.historyBox);
    this.screen.append(statusBar);
    
    // Set up key bindings
    this.screen.key(['q', 'C-c'], async () => {
      await this.cleanup();
      process.exit(0);
    });
    
    this.screen.key(['r'], () => {
      this.imbalanceHistory = new CircularBuffer(50);
      this.recentTrades = new CircularBuffer(100);
      this.screen.render();
    });
    
    this.screen.key(['t'], async () => {
      if (!this.tradingEnabled && this.enableTrading) {
        this.tradingEnabled = true;
        await this.initializeTrading();
        this.tradingBox.style.border.fg = 'green';
        console.log(chalk.green('Trading enabled'));
      } else if (this.tradingEnabled) {
        this.tradingEnabled = false;
        this.tradingBox.style.border.fg = 'red';
        await this.cleanup();
        console.log(chalk.yellow('Trading disabled'));
      } else if (!this.enableTrading) {
        console.log(chalk.red('Trading not available. Run with --trade flag to enable trading'));
      }
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
  
  async initialize() {
    if (this.tradingEnabled) {
      await this.initializeTrading();
    }
  }
  
  private async initializeTrading() {
    try {
      console.log(chalk.gray('Initializing MCP client...'));
      
      const transport = new StdioClientTransport({
        command: 'npx',
        args: ['tsx', 'src/mcpServers/binance.ts']
      });
      
      this.mcpClient = new Client({
        name: 'orderflow-mm',
        version: '1.0.0'
      }, {
        capabilities: {}
      });
      
      await this.mcpClient.connect(transport);
      console.log(chalk.green('✓ MCP client connected'));
      
      // Get account info
      await this.getAccountInfo();
      
      // Get exchange info
      await this.getExchangeInfo();
      
      // Initialize user data WebSocket
      await this.initializeUserDataWS();
      
      // Check existing positions
      await this.checkExistingPositions();
      
      this.tradingState = 'WATCHING';
    } catch (error) {
      console.error(chalk.red('Failed to initialize trading:'), error);
      this.tradingState = 'ERROR';
      this.tradingEnabled = false;
    }
  }
  
  private async getAccountInfo() {
    if (!this.mcpClient) return;
    
    const result = await this.mcpClient.callTool({
      name: 'get_account',
      arguments: {}
    });
    
    const response = JSON.parse((result.content as any)[0].text);
    const account = response.account || response;
    
    // Extract balance
    if (account.assets && Array.isArray(account.assets)) {
      const usdcAsset = account.assets.find((a: any) => a.asset === 'USDC');
      if (usdcAsset) {
        this.accountBalance = parseFloat(usdcAsset.availableBalance || usdcAsset.free || '0');
      }
    } else if (account.balances && Array.isArray(account.balances)) {
      const usdcBalance = account.balances.find((b: any) => b.asset === 'USDC');
      if (usdcBalance) {
        this.accountBalance = parseFloat(usdcBalance.free || usdcBalance.availableBalance || '0');
      }
    } else {
      this.accountBalance = parseFloat(account.availableBalance || account.totalWalletBalance || '0');
    }
    
    console.log(chalk.green(`✓ Account balance: $${this.accountBalance.toFixed(2)}`));
  }
  
  private async getExchangeInfo() {
    if (!this.mcpClient) return;
    
    try {
      const result = await this.mcpClient.callTool({
        name: 'get_exchange_info',
        arguments: {
          symbol: this.symbol
        }
      });
      
      const info = JSON.parse((result.content as any)[0].text);
      const lotSizeFilter = info.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      
      if (lotSizeFilter) {
        this.minOrderSize = parseFloat(lotSizeFilter.minQty);
        this.stepSize = parseFloat(lotSizeFilter.stepSize);
        console.log(chalk.gray(`Exchange info: minQty=${lotSizeFilter.minQty}, stepSize=${lotSizeFilter.stepSize}`));
      }
    } catch (error) {
      console.warn(chalk.yellow('Failed to get exchange info, using defaults'));
    }
  }
  
  private async initializeUserDataWS() {
    if (!this.mcpClient) return;
    
    console.log(chalk.gray('Initializing user data stream...'));
    
    this.userDataWS = new BinanceUserDataWS(
      this.mcpClient,
      (data) => this.handleUserDataUpdate(data)
    );
    
    await this.userDataWS.connect();
    console.log(chalk.green('✓ User data stream connected'));
  }
  
  private async handleUserDataUpdate(data: AccountUpdate | OrderUpdate) {
    if (data.eventType === 'ACCOUNT_UPDATE') {
      await this.handleAccountUpdate(data);
    } else if (data.eventType === 'ORDER_TRADE_UPDATE') {
      this.handleOrderUpdate(data);
    }
  }
  
  private async handleAccountUpdate(update: AccountUpdate) {
    // Update balance
    const usdcBalance = update.balances.find(b => b.asset === 'USDC');
    if (usdcBalance) {
      const newBalance = parseFloat(usdcBalance.walletBalance);
      if (newBalance !== this.accountBalance) {
        this.accountBalance = newBalance;
      }
    }
    
    // Check position updates
    if (this.position) {
      const positionUpdate = update.positions.find(p => p.symbol === this.symbol);
      
      if (positionUpdate) {
        const posAmt = parseFloat(positionUpdate.positionAmt);
        
        if (posAmt === 0) {
          // Position closed
          const unrealizedProfit = parseFloat(positionUpdate.unRealizedProfit);
          console.log(chalk.green(`\n✓ Position closed (PnL: $${unrealizedProfit.toFixed(2)})`));
          
          // Update stats
          this.tradingStats.totalTrades++;
          this.tradingStats.totalPnl += unrealizedProfit;
          if (unrealizedProfit > 0) {
            this.tradingStats.winningTrades++;
          } else {
            this.tradingStats.losingTrades++;
          }
          
          this.position = null;
          this.tradingState = 'WATCHING';
        }
      }
    }
  }
  
  private handleOrderUpdate(update: OrderUpdate) {
    if (this.markerOrder && update.orderId.toString() === this.markerOrder.orderId) {
      this.markerOrder.status = update.orderStatus as any;
      
      if (update.orderStatus === 'FILLED') {
        console.log(chalk.green(`✅ Order FILLED: ${update.side} ${update.originalQuantity} @ ${update.averagePrice}`));
        this.onOrderFilled();
      } else if (update.orderStatus === 'CANCELED') {
        console.log(chalk.yellow(`❌ Order cancelled`));
        this.markerOrder = null;
        this.tradingState = 'WATCHING';
      }
    }
  }
  
  private async checkExistingPositions() {
    if (!this.mcpClient) return;
    
    try {
      const result = await this.mcpClient.callTool({
        name: 'get_positions',
        arguments: {}
      });
      
      const response = JSON.parse((result.content as any)[0].text);
      const positions = response.positions || [];
      
      const openPosition = positions.find((p: any) => 
        p.symbol === this.symbol && Math.abs(parseFloat(p.positionAmt)) > 0
      );
      
      if (openPosition) {
        const positionAmt = parseFloat(openPosition.positionAmt);
        const side = positionAmt > 0 ? 'LONG' : 'SHORT';
        const entryPrice = parseFloat(openPosition.entryPrice);
        
        this.position = {
          symbol: openPosition.symbol,
          side,
          entryPrice,
          size: Math.abs(positionAmt),
          entryTime: Date.now() - 60000,
          slPrice: this.calculateSLPrice(side, entryPrice)
        };
        
        this.tradingState = 'POSITION_ACTIVE';
        console.log(chalk.yellow(`Found existing ${side} position @ ${entryPrice}`));
        
        // Place SL if missing
        await this.ensureSLOrder();
      }
    } catch (error) {
      console.error(chalk.red('Error checking existing positions:'), error);
    }
  }
  
  private calculateSLPrice(side: 'LONG' | 'SHORT', entryPrice: number): number {
    const slDistance = this.atrValue; // 1 ATR stop loss
    return side === 'LONG' 
      ? this.roundToTickSize(entryPrice - slDistance)
      : this.roundToTickSize(entryPrice + slDistance);
  }
  
  private roundToTickSize(price: number): number {
    const precision = this.getPrecisionFromMinSize(this.tickSize);
    return parseFloat((Math.round(price / this.tickSize) * this.tickSize).toFixed(precision));
  }
  
  private getPrecisionFromMinSize(minSize: number): number {
    if (minSize >= 1) return 0;
    return Math.max(0, Math.ceil(-Math.log10(minSize)));
  }
  
  private calculatePositionSize(): number {
    if (this.accountBalance < 5) {
      return 0;
    }
    
    const riskAmount = Math.min(this.accountBalance * 0.05, 50);
    const currentPrice = this.getCurrentPrice();
    if (!currentPrice) return 0;
    
    const positionSize = riskAmount / currentPrice;
    const rounded = this.roundToStepSize(positionSize);
    
    const notional = rounded * currentPrice;
    if (notional < 5) {
      return 0;
    }
    
    return rounded;
  }
  
  private roundToStepSize(quantity: number): number {
    const rounded = Math.floor(quantity / this.stepSize) * this.stepSize;
    
    if (this.stepSize >= 1) {
      return Math.floor(rounded);
    }
    
    let precision = 0;
    const stepSizeStr = this.stepSize.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
    const decimalIndex = stepSizeStr.indexOf('.');
    if (decimalIndex !== -1) {
      precision = stepSizeStr.length - decimalIndex - 1;
    }
    
    precision = Math.min(precision, 8);
    return parseFloat(rounded.toFixed(precision));
  }
  
  private lastOrderbook: OrderbookSnapshot | null = null;
  
  private getCurrentPrice(): number | null {
    if (!this.lastOrderbook || this.lastOrderbook.bids.length === 0 || this.lastOrderbook.asks.length === 0) {
      return null;
    }
    return (this.lastOrderbook.bids[0].price + this.lastOrderbook.asks[0].price) / 2;
  }
  
  private async handleSignal(signal: any) {
    if (!this.tradingEnabled || !this.mcpClient) return;
    
    // Handle MM signals from OrderFlowImbalance
    if (!signal || !signal.type) return;
    
    console.log(chalk.cyan(`Signal received: ${signal.type}`));
    
    // Handle different signal types
    switch (signal.type) {
      case 'CANCEL':
        if (this.markerOrder) {
          console.log(chalk.yellow(`Signal: ${signal.reason || 'Cancel orders'}`));
          await this.cancelMarkerOrder();
        }
        break;
        
      case 'SETUP':
        console.log(chalk.cyan(`SETUP signal received. State: ${this.tradingState}, MarkerOrder: ${!!this.markerOrder}, Position: ${!!this.position}`));
        // Only act if we're in WATCHING state and don't have existing orders/positions
        if (this.tradingState === 'WATCHING' && !this.markerOrder && !this.position) {
          // For directional trading, we need to determine which side to trade
          // Based on the MM signal's bid/ask setup, we'll trade in the direction of imbalance
          const { priceImpactImbalance, orderbookPressure, microstructureFlowImbalance, flowToxicity } = signal.metrics;
          console.log(chalk.gray(`Metrics: PII=${priceImpactImbalance.toFixed(3)}, OBP=${orderbookPressure.toFixed(3)}, MFI=${microstructureFlowImbalance.toFixed(3)}, Toxicity=${flowToxicity.toFixed(3)}`));
          
          // Skip if toxicity is too high for directional trading
          if (flowToxicity > 0.4) {
            console.log(chalk.yellow('Toxicity too high for directional trade'));
            return;
          }
          
          let side: 'BUY' | 'SELL' | null = null;
          let orderPrice = 0;
          
          // Determine direction based on imbalances
          // Strong PII > 0 means easier to push price up (buy pressure)
          // Strong PII < 0 means easier to push price down (sell pressure)
          if (priceImpactImbalance > 0.5 && microstructureFlowImbalance > 0.3) {
            side = 'BUY';
            // Use the bid price from MM signal or calculate our own
            orderPrice = signal.bidPrice || (this.getCurrentPrice()! - this.tickSize);
          } else if (priceImpactImbalance < -0.5 && microstructureFlowImbalance < -0.3) {
            side = 'SELL';
            // Use the ask price from MM signal or calculate our own
            orderPrice = signal.askPrice || (this.getCurrentPrice()! + this.tickSize);
          } else if (Math.abs(orderbookPressure) > 0.6) {
            // Trade based on orderbook pressure
            if (orderbookPressure > 0.6) {
              // Bid side stronger, buy pressure
              side = 'BUY';
              orderPrice = signal.bidPrice || (this.getCurrentPrice()! - this.tickSize);
            } else {
              // Ask side stronger, sell pressure
              side = 'SELL';
              orderPrice = signal.askPrice || (this.getCurrentPrice()! + this.tickSize);
            }
          }
          
          if (side && orderPrice > 0) {
            console.log(chalk.green(`Placing ${side} order based on imbalances`));
            await this.placeMarkerOrder({
              side,
              price: this.roundToTickSize(orderPrice),
              reason: signal.reason || `${signal.type} signal: PII=${priceImpactImbalance.toFixed(2)}, MFI=${microstructureFlowImbalance.toFixed(2)}`
            });
          } else {
            console.log(chalk.gray(`No clear directional signal: PII=${priceImpactImbalance.toFixed(3)}, OBP=${orderbookPressure.toFixed(3)}, MFI=${microstructureFlowImbalance.toFixed(3)}`));
          }
        }
        break;
    }
  }
  
  private async placeMarkerOrder(params: { side: 'BUY' | 'SELL', price: number, reason: string }) {
    if (!this.mcpClient || this.markerOrder || this.position) return;
    
    const operationKey = `marker_order_${this.symbol}`;
    if (!this.backoff.canAttempt(operationKey)) {
      return;
    }
    
    const positionSize = this.calculatePositionSize();
    if (positionSize === 0) {
      return;
    }
    
    try {
      console.log(chalk.cyan(`\n📊 Placing ${params.side} order @ ${params.price.toFixed(this.pricePrecision)}`));
      console.log(chalk.gray(`  Reason: ${params.reason}`));
      
      const result = await this.mcpClient.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.symbol,
          side: params.side,
          type: 'LIMIT',
          quantity: positionSize,
          price: params.price,
          timeInForce: 'GTX' // Post-only
        }
      });
      
      const responseText = (result.content as any)[0].text;
      
      if (responseText.includes('error')) {
        const errorData = JSON.parse(responseText);
        if (!errorData.error.includes('could not be executed as maker')) {
          console.error(chalk.red('Order placement failed:'), errorData.error);
        }
        throw new Error(errorData.error);
      }
      
      const order = JSON.parse(responseText);
      
      this.markerOrder = {
        orderId: order.orderId.toString(),
        symbol: order.symbol,
        side: order.side,
        price: parseFloat(order.price),
        size: parseFloat(order.origQty),
        status: 'NEW'
      };
      
      this.tradingState = 'ORDER_PLACED';
      console.log(chalk.green(`✓ Order placed #${order.orderId}`));
      this.backoff.recordSuccess(operationKey);
    } catch (error: any) {
      if (!error.message?.includes('could not be executed as maker')) {
        console.error(chalk.red('Failed to place order:'), error);
        const nextRetrySeconds = this.backoff.recordFailure(operationKey);
        console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`));
      }
    }
  }
  
  private async cancelMarkerOrder() {
    if (!this.mcpClient || !this.markerOrder) return;
    
    try {
      await this.mcpClient.callTool({
        name: 'cancel_order',
        arguments: {
          symbol: this.markerOrder.symbol,
          orderId: this.markerOrder.orderId
        }
      });
      
      console.log(chalk.yellow(`✓ Cancelled order #${this.markerOrder.orderId}`));
      this.markerOrder = null;
      this.tradingState = 'WATCHING';
    } catch (error) {
      console.error(chalk.red('Failed to cancel order:'), error);
    }
  }
  
  private async onOrderFilled() {
    if (!this.markerOrder) return;
    
    const side = this.markerOrder.side === 'BUY' ? 'LONG' : 'SHORT';
    
    this.position = {
      symbol: this.markerOrder.symbol,
      side,
      entryPrice: this.markerOrder.price,
      size: this.markerOrder.size,
      entryTime: Date.now(),
      slPrice: this.calculateSLPrice(side, this.markerOrder.price)
    };
    
    this.markerOrder = null;
    this.tradingState = 'POSITION_ACTIVE';
    this.tradingStats.lastTradeTime = Date.now();
    
    console.log(chalk.green(`\n✓ Position opened: ${side} @ ${this.position.entryPrice}`));
    console.log(chalk.gray(`  SL: ${this.position.slPrice.toFixed(this.pricePrecision)}`));
    
    // Place stop loss immediately
    await this.placeSLOrder();
  }
  
  private async placeSLOrder() {
    if (!this.mcpClient || !this.position) return;
    
    try {
      const result = await this.mcpClient.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          quantity: this.position.size,
          stopPrice: this.position.slPrice,
          reduceOnly: true
        }
      });
      
      const responseText = (result.content as any)[0].text;
      
      if (!responseText.includes('error')) {
        const slOrder = JSON.parse(responseText);
        this.position.slOrderId = slOrder.orderId;
        console.log(chalk.green(`✓ SL order placed #${slOrder.orderId} @ ${this.position.slPrice.toFixed(this.pricePrecision)}`));
      }
    } catch (error) {
      console.error(chalk.red('Failed to place SL order:'), error);
    }
  }
  
  private async ensureSLOrder() {
    if (!this.position || this.position.slOrderId) return;
    
    console.log(chalk.yellow('SL order missing, placing now...'));
    await this.placeSLOrder();
  }
  
  private async cleanup() {
    if (this.markerOrder) {
      await this.cancelMarkerOrder();
    }
    
    if (this.userDataWS) {
      await this.userDataWS.disconnect();
    }
    
    this.mcpClient = null;
    this.tradingEnabled = false;
  }
  
  // Format trading status for display
  private formatTradingStatus(): string {
    const lines: string[] = [];
    
    lines.push(`{bold}Mode:{/bold} ${this.tradingEnabled ? '{green-fg}LIVE{/green-fg}' : '{red-fg}VIEW ONLY{/red-fg}'}`);
    lines.push(`{bold}State:{/bold} ${this.tradingState}`);
    lines.push(`{bold}Balance:{/bold} $${this.accountBalance.toFixed(2)}`);
    lines.push('');
    
    if (this.position) {
      lines.push('{bold}Position:{/bold}');
      lines.push(`Side: ${this.position.side}`);
      lines.push(`Entry: ${this.position.entryPrice.toFixed(this.pricePrecision)}`);
      lines.push(`Size: ${this.position.size}`);
      lines.push(`SL: ${this.position.slPrice.toFixed(this.pricePrecision)}`);
      
      const currentPrice = this.getCurrentPrice();
      if (currentPrice) {
        const pnl = this.position.side === 'LONG'
          ? (currentPrice - this.position.entryPrice) * this.position.size
          : (this.position.entryPrice - currentPrice) * this.position.size;
        const pnlBps = (pnl / (this.position.entryPrice * this.position.size)) * 10000;
        lines.push(`PnL: ${pnl >= 0 ? '{green-fg}' : '{red-fg}'}${pnl.toFixed(2)} (${pnlBps.toFixed(1)}bps){/}`);
      }
    } else if (this.markerOrder) {
      lines.push('{bold}Pending Order:{/bold}');
      lines.push(`Side: ${this.markerOrder.side}`);
      lines.push(`Price: ${this.markerOrder.price.toFixed(this.pricePrecision)}`);
      lines.push(`Size: ${this.markerOrder.size}`);
    }
    
    lines.push('');
    lines.push('{bold}Statistics:{/bold}');
    lines.push(`Trades: ${this.tradingStats.totalTrades}`);
    if (this.tradingStats.totalTrades > 0) {
      const winRate = (this.tradingStats.winningTrades / this.tradingStats.totalTrades * 100).toFixed(1);
      lines.push(`Win Rate: ${winRate}%`);
      lines.push(`Total PnL: ${this.tradingStats.totalPnl >= 0 ? '{green-fg}' : '{red-fg}'}$${this.tradingStats.totalPnl.toFixed(2)}{/}`);
    }
    
    return lines.join('\n');
  }
  
  // Original TUI methods continue below...
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
    
    lines.push(`{bold}Trade Flow:{/bold}`);
    lines.push(`Buy:  ${buyVolume.toFixed(2)} (${buyRatio.toFixed(1)}%)`);
    lines.push(`Sell: ${sellVolume.toFixed(2)} (${sellRatio.toFixed(1)}%)`);
    lines.push('');
    
    lines.push(`{bold}Large Trades:{/bold}`);
    lines.push(`Buy:  ${largeBuyVolume.toFixed(2)}`);
    lines.push(`Sell: ${largeSellVolume.toFixed(2)}`);
    lines.push(`Avg:  ${this.avgTradeSize.toFixed(2)}`);
    
    return lines.join('\n');
  }
  
  private formatSignals(signal: any): string {
    const lines: string[] = [];
    
    if (!signal || !signal.metrics) {
      lines.push('No active signal');
      lines.push('');
      lines.push('{bold}Waiting for conditions:{/bold}');
      lines.push('• Monitoring flow toxicity');
      lines.push('• Tracking imbalances');
      lines.push('• Detecting patterns');
      return lines.join('\n');
    }
    
    // Show MM signal type
    if (signal.type) {
      if (signal.type === 'SETUP') {
        lines.push(`{bold}{green-fg}═══ ${signal.type} SIGNAL ═══{/green-fg}{/bold}`);
        if (signal.bidPrice && signal.askPrice) {
          lines.push(`Bid: ${signal.bidPrice.toFixed(this.pricePrecision)}`);
          lines.push(`Ask: ${signal.askPrice.toFixed(this.pricePrecision)}`);
        }
      } else if (signal.type === 'CANCEL') {
        lines.push(`{bold}{red-fg}═══ ${signal.type} SIGNAL ═══{/red-fg}{/bold}`);
      }
      lines.push('');
      if (signal.reason) {
        lines.push(`Reason: ${signal.reason}`);
        lines.push('');
      }
    }
    
    // Show metrics for interpretation
    const { priceImpactImbalance, flowToxicity, microstructureFlowImbalance, orderbookPressure } = signal.metrics;
    
    lines.push('{bold}Metrics:{/bold}');
    lines.push(`PII: ${priceImpactImbalance.toFixed(3)}`);
    lines.push(`OBP: ${orderbookPressure.toFixed(3)}`);
    lines.push(`MFI: ${microstructureFlowImbalance.toFixed(3)}`);
    lines.push(`Toxicity: ${flowToxicity.toFixed(3)}`);
    
    // Add directional interpretation
    if (this.tradingEnabled) {
      lines.push('');
      if (flowToxicity > 0.4) {
        lines.push('{yellow-fg}⚠ High toxicity - No trade{/yellow-fg}');
      } else if (priceImpactImbalance > 0.5 && microstructureFlowImbalance > 0.3) {
        lines.push('{green-fg}→ BUY pressure detected{/green-fg}');
      } else if (priceImpactImbalance < -0.5 && microstructureFlowImbalance < -0.3) {
        lines.push('{red-fg}→ SELL pressure detected{/red-fg}');
      } else if (orderbookPressure > 0.6) {
        lines.push('{green-fg}→ BUY support (OBP){/green-fg}');
      } else if (orderbookPressure < -0.6) {
        lines.push('{red-fg}→ SELL pressure (OBP){/red-fg}');
      }
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
          signalText += ` Bid:${s.bidPrice.toFixed(this.pricePrecision)} Ask:${s.askPrice.toFixed(this.pricePrecision)}`;
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
      // Store current orderbook for price calculations
      this.lastOrderbook = orderbook;
      
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
      
      // Handle trading signal
      if (signal && signal.type) {
        // Fire and forget - don't await to avoid blocking UI updates
        this.handleSignal(signal).catch(error => {
          console.error(chalk.red('Error handling signal:'), error);
        });
      }
      
      // Store history and update last known good data
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
      
      // Update display boxes
      this.orderbookBox.setContent(this.formatOrderbook(orderbook));
      
      const hasValidCurrentMetrics = signal && signal.metrics && typeof signal.metrics.priceImpactImbalance === 'number';
      const metricsToDisplay = hasValidCurrentMetrics ? signal.metrics : this.lastMetrics;
      const signalToDisplay = hasValidCurrentMetrics ? signal : this.lastSignal;
      
      if (metricsToDisplay) {
        this.metricsBox.setContent(this.formatMetrics(metricsToDisplay));
      }
      
      if (signalToDisplay) {
        this.signalBox.setContent(this.formatSignals(signalToDisplay));
      }
      
      this.flowBox.setContent(this.formatFlowAnalysis(this.recentTrades.getAll()));
      this.historyBox.setContent(this.formatHistory());
      this.tradingBox.setContent(this.formatTradingStatus());
      
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
    .name('orderflow-mm')
    .description('Order Flow Market Making tool for Binance futures')
    .version('1.0.0')
    .argument('[symbol]', 'Trading symbol (e.g., BTCUSDT)')
    .option('-s, --symbol <symbol>', 'Trading symbol (alternative to positional argument)')
    .option('-a, --atr <number>', 'ATR value', parseFloat, 50.0)
    .option('-t, --avg-trade <number>', 'Average trade size', parseFloat, 0.5)
    .option('-p, --avg-spread <number>', 'Average spread', parseFloat, 0.1)
    .option('-u, --update-speed <ms>', 'Update speed in milliseconds', '100')
    .option('-d, --depth <levels>', 'Orderbook depth levels', '20')
    .option('--trade', 'Enable live trading (default: view only)', false);
  
  program.parse();
  const options = program.opts();
  const args = program.args;
  
  // Get symbol from argument or option
  const symbol = args[0] || options.symbol;
  if (!symbol) {
    console.error('Error: Symbol is required');
    console.error('Usage: npm run orderflow-mm BTCUSDT');
    process.exit(1);
  }
  
  // Create TUI with trading capability
  const tui = new OrderFlowMMTUI(
    symbol.toUpperCase(),
    options.atr,
    options.avgTrade,
    options.avgSpread,
    options.trade
  );
  
  // Initialize trading components if enabled
  await tui.initialize();
  
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