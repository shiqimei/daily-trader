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
  tpOrderId?: string;
  tpPrice?: number;
  unrealizedPnl?: number;
}

interface MarkerOrder {
  bidOrderId?: string;
  askOrderId?: string;
  symbol: string;
  bidPrice?: number;
  askPrice?: number;
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
  private logsBox: blessed.Widgets.BoxElement; // New logs panel
  private logMessages: string[] = []; // Store all log messages
  
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
  private tradingEnabled: boolean = true; // Enable by default
  private tradingLogs: string[] = [];
  private autoScrollLogs: boolean = true; // Auto-scroll enabled by default
  private isProcessingSignal: boolean = false; // Prevent concurrent signal processing
  private lastSignalTime: number = 0; // Track last signal time
  private signalCooldownMs: number = 1000; // Minimum time between signals
  
  private log(message: string, type: 'info' | 'warn' | 'error' | 'success' = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    let coloredMsg = message;
    switch(type) {
      case 'error': coloredMsg = `{red-fg}${message}{/red-fg}`; break;
      case 'warn': coloredMsg = `{yellow-fg}${message}{/yellow-fg}`; break;
      case 'success': coloredMsg = `{green-fg}${message}{/green-fg}`; break;
      default: coloredMsg = `{gray-fg}${message}{/gray-fg}`;
    }
    
    // Add to logs panel if it exists
    if (this.logsBox) {
      // Add message to our array
      this.logMessages.push(`${timestamp} ${coloredMsg}`);
      
      // Keep only last 1000 messages to prevent memory issues
      if (this.logMessages.length > 1000) {
        this.logMessages = this.logMessages.slice(-1000);
      }
      
      // Update content
      this.logsBox.setContent(this.logMessages.join('\n'));
      
      // Auto-scroll logic - only scroll if enabled
      if (this.autoScrollLogs) {
        this.logsBox.setScrollPerc(100);
      }
      // If auto-scroll is off, the box will maintain its current scroll position
      
      this.screen.render();
    }
    
    // Also keep in trading logs for trading status panel
    this.tradingLogs.push(`${timestamp} ${coloredMsg}`);
    // Keep only last 10 logs for trading status
    if (this.tradingLogs.length > 10) {
      this.tradingLogs.shift();
    }
  }
  
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
    
    this.backoff = new ExponentialBackoff(3000, 60000, 2);
    
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: `Order Flow MM - ${symbol}`,
      fullUnicode: true,
      forceUnicode: true,
      tags: true
    });
    
    // Create layout with logs panel at bottom
    this.orderbookBox = blessed.box({
      label: ' Order Book ',
      left: 0,
      top: 0,
      width: '25%',
      height: '40%',
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
      height: '40%',
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
      height: '40%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: 'magenta' }
      }
    });
    
    // Trading status box
    this.tradingBox = blessed.box({
      label: ' Trading Status ',
      left: '80%',
      top: 0,
      width: '20%',
      height: '40%',
      border: { type: 'line' },
      scrollable: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: 'green' }
      }
    });
    
    this.signalBox = blessed.box({
      label: ' Signals ',
      left: 0,
      top: '40%',
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
      top: '40%',
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
      top: '40%',
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
    
    // New logs panel at bottom
    this.logsBox = blessed.box({
      label: ' System Logs [Auto-scroll: ON] ',
      left: 0,
      bottom: 1,
      width: '100%',
      height: '35%',
      border: { type: 'line' },
      scrollable: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'gray'
        },
        style: {
          inverse: true
        }
      },
      mouse: true,
      vi: true,
      keys: true,
      tags: true,
      style: {
        border: { fg: 'gray' }
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
    
    statusBar.setContent(` ${symbol} | ATR: ${atrValue} | Mode: LIVE TRADING | 'q' quit | 'r' reset | 'l' logs | 'a' auto-scroll | ESC unfocus `);
    
    // Add all boxes to screen
    this.screen.append(this.orderbookBox);
    this.screen.append(this.metricsBox);
    this.screen.append(this.flowBox);
    this.screen.append(this.tradingBox);
    this.screen.append(this.signalBox);
    this.screen.append(this.tradesBox);
    this.screen.append(this.historyBox);
    this.screen.append(this.logsBox);
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
    
    // Log navigation shortcuts
    this.screen.key(['l'], () => {
      // Focus logs box
      this.logsBox.focus();
      this.screen.render();
    });
    
    this.screen.key(['escape'], () => {
      // Unfocus any focused element
      this.screen.focusPop();
      this.screen.render();
    });
    
    // Toggle auto-scroll
    this.screen.key(['a'], () => {
      this.autoScrollLogs = !this.autoScrollLogs;
      this.logsBox.setLabel(` System Logs [Auto-scroll: ${this.autoScrollLogs ? 'ON' : 'OFF'}] `);
      
      // If enabling auto-scroll, jump to bottom
      if (this.autoScrollLogs) {
        this.logsBox.setScrollPerc(100);
      }
      
      this.screen.render();
    });
    
    // Page up/down for logs when focused
    this.logsBox.key(['pageup'], () => {
      this.logsBox.scroll(-10);
      this.screen.render();
    });
    
    this.logsBox.key(['pagedown'], () => {
      this.logsBox.scroll(10);
      this.screen.render();
    });
    
    // Home/End for logs
    this.logsBox.key(['home'], () => {
      this.logsBox.setScrollPerc(0);
      this.screen.render();
    });
    
    this.logsBox.key(['end'], () => {
      this.logsBox.setScrollPerc(100);
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
    try {
      this.log('Initializing trading system...', 'info');
      await this.initializeTrading();
      
      // Update the trading box with initial status
      this.tradingBox.setContent(this.formatTradingStatus());
      this.screen.render();
    } catch (error: any) {
      this.log(`Initialize error: ${error.message || error}`, 'error');
      this.tradingState = 'ERROR';
      this.tradingBox.setContent(this.formatTradingStatus());
      this.screen.render();
    }
  }
  
  private async initializeTrading() {
    try {
      this.log('Initializing MCP client...', 'info');
      
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
      this.log('MCP client connected', 'success');
      
      // List available tools to verify connection
      const tools = await this.mcpClient.listTools();
      this.log(`Available tools: ${tools.tools.length}`, 'info');
      
      // Get account info
      await this.getAccountInfo();
      
      // Get exchange info
      await this.getExchangeInfo();
      
      // Initialize user data WebSocket
      await this.initializeUserDataWS();
      
      // Check existing positions
      await this.checkExistingPositions();
      
      // Only set to WATCHING if no position was found
      if (this.tradingState === 'IDLE') {
        this.tradingState = 'WATCHING';
      }
      this.log('Trading initialized', 'success');
    } catch (error: any) {
      this.log(`Failed to initialize: ${error.message || error}`, 'error');
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
    
    // Debug log the response structure (before console suppression)
    this.log('Checking account structure...', 'info');
    
    // Handle different response structures
    const account = response.account || response;
    
    // Check if we have assets array
    if (account.assets && Array.isArray(account.assets)) {
      // Find USDC balance
      const usdcAsset = account.assets.find((a: any) => a.asset === 'USDC');
      if (usdcAsset) {
        this.accountBalance = parseFloat(usdcAsset.availableBalance || usdcAsset.free || '0');
      } else {
        // Sum all available balances
        this.accountBalance = account.assets.reduce((sum: number, asset: any) => {
          return sum + parseFloat(asset.availableBalance || asset.free || '0');
        }, 0);
      }
    } else if (account.balances && Array.isArray(account.balances)) {
      // Alternative structure with balances array
      const usdcBalance = account.balances.find((b: any) => b.asset === 'USDC');
      if (usdcBalance) {
        this.accountBalance = parseFloat(usdcBalance.free || usdcBalance.availableBalance || '0');
      } else {
        // Sum all free balances
        this.accountBalance = account.balances.reduce((sum: number, balance: any) => {
          return sum + parseFloat(balance.free || balance.availableBalance || '0');
        }, 0);
      }
    } else {
      // Fallback to direct fields
      this.accountBalance = parseFloat(account.availableBalance || account.totalWalletBalance || '0');
    }
    
    // Show more detailed balance info
    this.log(`Balance: $${this.accountBalance.toFixed(2)}`, 'success');
    if (account.totalWalletBalance) {
      this.log(`Total Wallet: $${parseFloat(account.totalWalletBalance).toFixed(2)}`, 'info');
    }
    if (account.totalUnrealizedProfit && parseFloat(account.totalUnrealizedProfit) !== 0) {
      this.log(`Unrealized PnL: $${parseFloat(account.totalUnrealizedProfit).toFixed(2)}`, 'info');
    }
    
    // Warning for low balance but don't block trading
    if (this.accountBalance < 20) {
      this.log(`Low balance warning: $${this.accountBalance.toFixed(2)}`, 'warn');
    }
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
      
      // Get LOT_SIZE filter
      const lotSizeFilter = info.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      if (lotSizeFilter) {
        this.minOrderSize = parseFloat(lotSizeFilter.minQty);
        this.stepSize = parseFloat(lotSizeFilter.stepSize);
        this.log(`Lot size - Min: ${lotSizeFilter.minQty}, Step: ${lotSizeFilter.stepSize}`, 'info');
        
        // Validate stepSize
        if (isNaN(this.stepSize) || this.stepSize <= 0) {
          this.log(`Invalid stepSize ${lotSizeFilter.stepSize}, using default 0.001`, 'warn');
          this.stepSize = 0.001;
        }
      }
      
      // Get PRICE_FILTER filter
      const priceFilter = info.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
      if (priceFilter) {
        this.tickSize = parseFloat(priceFilter.tickSize);
        this.log(`Price filter - Tick size: ${priceFilter.tickSize}`, 'info');
        
        // Update price precision based on tick size
        if (this.tickSize < 1) {
          const tickStr = this.tickSize.toString();
          const decimalIndex = tickStr.indexOf('.');
          if (decimalIndex !== -1) {
            this.pricePrecision = tickStr.substring(decimalIndex + 1).length;
          }
        } else {
          this.pricePrecision = 0;
        }
        
        this.log(`Using tick size: ${this.tickSize}, precision: ${this.pricePrecision}`, 'info');
      }
      
    } catch (error) {
      this.log('Failed to get exchange info, using defaults', 'warn');
      this.minOrderSize = 0.001;
      this.stepSize = 0.001;
    }
  }
  
  private async initializeUserDataWS() {
    if (!this.mcpClient) return;
    
    this.log('Initializing user data stream...', 'info');
    
    this.userDataWS = new BinanceUserDataWS(
      this.mcpClient,
      (data) => this.handleUserDataUpdate(data),
      (message, level) => this.log(message, level as any)
    );
    
    await this.userDataWS.connect();
    this.log('User data stream connected', 'success');
  }
  
  private async handleUserDataUpdate(data: AccountUpdate | OrderUpdate) {
    if (data.eventType === 'ACCOUNT_UPDATE') {
      await this.handleAccountUpdate(data);
    } else if (data.eventType === 'ORDER_TRADE_UPDATE') {
      await this.handleOrderUpdate(data);
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
    
    // Check position updates for our symbol
    const positionUpdate = update.positions.find(p => p.symbol === this.symbol);
    
    if (positionUpdate) {
      const posAmt = parseFloat(positionUpdate.positionAmt);
      
      if (posAmt === 0) {
        // Position closed
        if (this.position) {
          const unrealizedProfit = parseFloat(positionUpdate.unRealizedProfit);
          this.log(`Position closed (PnL: $${unrealizedProfit.toFixed(2)})`, 'success');
          
          // Update stats
          this.tradingStats.totalTrades++;
          this.tradingStats.totalPnl += unrealizedProfit;
          if (unrealizedProfit > 0) {
            this.tradingStats.winningTrades++;
          } else {
            this.tradingStats.losingTrades++;
          }
          
          this.position = null;
        }
        
        // Reset to watching state if we're in position-related state
        if (this.tradingState === 'POSITION_ACTIVE' || this.tradingState === 'CLOSING') {
          this.tradingState = 'WATCHING';
          this.log('No position detected, switched to WATCHING state', 'info');
        }
      } else {
        // Position exists
        if (!this.position) {
          // New position detected that we didn't track
          const side = posAmt > 0 ? 'LONG' : 'SHORT';
          const entryPrice = parseFloat(positionUpdate.entryPrice);
          
          this.position = {
            symbol: this.symbol,
            side,
            entryPrice,
            size: Math.abs(posAmt),
            entryTime: Date.now(),
            slPrice: this.calculateSLPrice(side, entryPrice),
            tpPrice: this.calculateTPPrice(side, entryPrice)
          };
          
          // Change state to POSITION_ACTIVE regardless of previous state
          // This handles the case where we go from empty to active position
          this.tradingState = 'POSITION_ACTIVE';
          this.log(`Position opened: ${side} @ ${entryPrice} (via WebSocket)`, 'success');
          this.log(`Entering position management state - waiting for SL/TP`, 'info');
          
          // Place SL/TP orders for the detected position
          await this.placePositionOrders();
        } else {
          // Update existing position size if changed
          const newSize = Math.abs(posAmt);
          if (newSize !== this.position.size) {
            this.log(`Position size changed: ${this.position.size} → ${newSize}`, 'warn');
            this.position.size = newSize;
            
            // May need to update SL/TP orders if size changed significantly
            await this.ensurePositionOrders();
          }
        }
      }
    } else if (this.position) {
      // No position update for our symbol but we think we have a position
      // This might mean the position was closed
      this.position = null;
      if (this.tradingState === 'POSITION_ACTIVE' || this.tradingState === 'CLOSING') {
        this.tradingState = 'WATCHING';
        this.log('Position closed, switched to WATCHING state', 'info');
      }
    }
  }
  
  private async handleOrderUpdate(update: OrderUpdate) {
    const orderId = update.orderId.toString();
    
    // Check if this is a TP or SL order
    if (this.position) {
      if (orderId === this.position.tpOrderId || orderId === this.position.slOrderId) {
        const isTP = orderId === this.position.tpOrderId;
        const orderType = isTP ? 'TP' : 'SL';
        
        if (update.orderStatus === 'FILLED') {
          this.log(`${orderType} order FILLED: Closing position`, 'success');
          
          // Position will be closed, state will be updated via handleAccountUpdate
          // but we can set it to CLOSING to indicate we're expecting the position to close
          this.tradingState = 'CLOSING';
          
          // Cancel the other order (TP if SL filled, SL if TP filled)
          if (isTP && this.position.slOrderId) {
            await this.mcpClient?.callTool({
              name: 'cancel_order',
              arguments: {
                symbol: this.symbol,
                orderId: this.position.slOrderId
              }
            }).catch(err => this.log(`Failed to cancel SL: ${err}`, 'error'));
          } else if (!isTP && this.position.tpOrderId) {
            await this.mcpClient?.callTool({
              name: 'cancel_order',
              arguments: {
                symbol: this.symbol,
                orderId: this.position.tpOrderId
              }
            }).catch(err => this.log(`Failed to cancel TP: ${err}`, 'error'));
          }
        }
        return;
      }
    }
    
    // Check if this is one of our MM orders
    if (this.markerOrder && (orderId === this.markerOrder.bidOrderId || orderId === this.markerOrder.askOrderId)) {
      const isBidOrder = orderId === this.markerOrder.bidOrderId;
      const orderType = isBidOrder ? 'Bid' : 'Ask';
      
      if (update.orderStatus === 'FILLED') {
        this.log(`${orderType} FILLED: ${update.originalQuantity} @ ${update.averagePrice}`, 'success');
        
        // When one side fills, cancel the other side and create position
        const side = update.side === 'BUY' ? 'LONG' : 'SHORT';
        const fillPrice = parseFloat(update.averagePrice);
        
        // Cancel the opposite side order
        if (isBidOrder && this.markerOrder.askOrderId) {
          await this.mcpClient?.callTool({
            name: 'cancel_order',
            arguments: {
              symbol: this.symbol,
              orderId: this.markerOrder.askOrderId
            }
          }).catch(err => this.log(`Failed to cancel ask: ${err}`, 'error'));
        } else if (!isBidOrder && this.markerOrder.bidOrderId) {
          await this.mcpClient?.callTool({
            name: 'cancel_order',
            arguments: {
              symbol: this.symbol,
              orderId: this.markerOrder.bidOrderId
            }
          }).catch(err => this.log(`Failed to cancel bid: ${err}`, 'error'));
        }
        
        // Create position
        this.position = {
          symbol: this.markerOrder.symbol,
          side,
          entryPrice: fillPrice,
          size: this.markerOrder.size,
          entryTime: Date.now(),
          slPrice: this.calculateSLPrice(side, fillPrice),
          tpPrice: this.calculateTPPrice(side, fillPrice)
        };
        
        this.markerOrder = null;
        this.tradingState = 'POSITION_ACTIVE';
        this.tradingStats.lastTradeTime = Date.now();
        
        this.log(`Position opened: ${side} @ ${fillPrice}`, 'success');
        this.log(`Target: SL @ ${this.position.slPrice.toFixed(this.pricePrecision)}, TP @ ${this.position.tpPrice.toFixed(this.pricePrecision)}`, 'info');
        
        // Place both SL and TP orders immediately
        await this.placePositionOrders();
        
      } else if (update.orderStatus === 'CANCELED') {
        this.log(`${orderType} order cancelled`, 'warn');
        
        // Update marker order state
        if (isBidOrder) {
          this.markerOrder.bidOrderId = undefined;
        } else {
          this.markerOrder.askOrderId = undefined;
        }
        
        // If both orders are cancelled, reset state
        if (!this.markerOrder.bidOrderId && !this.markerOrder.askOrderId) {
          this.markerOrder = null;
          this.tradingState = 'WATCHING';
        }
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
          slPrice: this.calculateSLPrice(side, entryPrice),
          tpPrice: this.calculateTPPrice(side, entryPrice)
        };
        
        this.tradingState = 'POSITION_ACTIVE';
        this.log(`Found existing ${side} position @ ${entryPrice}`, 'warn');
        
        // Check if calculated prices are valid
        if (this.position.slPrice <= 0 || this.position.tpPrice <= 0) {
          this.log(`Invalid price calculation detected, using percentage-based targets`, 'warn');
          // Fallback to simple percentage-based targets
          if (side === 'LONG') {
            this.position.slPrice = this.roundToTickSize(entryPrice * 0.99); // 1% SL
            this.position.tpPrice = this.roundToTickSize(entryPrice * 1.02); // 2% TP
          } else {
            this.position.slPrice = this.roundToTickSize(entryPrice * 1.01); // 1% SL
            this.position.tpPrice = this.roundToTickSize(entryPrice * 0.98); // 2% TP
          }
        }
        
        this.log(`Setting targets: SL @ ${this.position.slPrice.toFixed(this.pricePrecision)}, TP @ ${this.position.tpPrice.toFixed(this.pricePrecision)}`, 'info');
        
        // Place both SL and TP orders if missing
        await this.placePositionOrders();
      }
    } catch (error) {
      this.log(`Error checking positions: ${error}`, 'error');
    }
  }
  
  private calculateSLPrice(side: 'LONG' | 'SHORT', entryPrice: number): number {
    // For crypto, ATR is usually a percentage, not absolute price
    // Use 1% of price as stop loss if ATR is too large
    const slDistance = Math.min(this.atrValue, entryPrice * 0.01);
    return side === 'LONG' 
      ? this.roundToTickSize(entryPrice - slDistance)
      : this.roundToTickSize(entryPrice + slDistance);
  }
  
  private calculateTPPrice(side: 'LONG' | 'SHORT', entryPrice: number): number {
    // Use 2% of price as take profit for 2:1 risk/reward
    const tpDistance = Math.min(this.atrValue * 2, entryPrice * 0.02);
    return side === 'LONG'
      ? this.roundToTickSize(entryPrice + tpDistance)
      : this.roundToTickSize(entryPrice - tpDistance);
  }
  
  private roundToTickSize(price: number): number {
    // Round to nearest tick
    const rounded = Math.round(price / this.tickSize) * this.tickSize;
    
    // Determine precision from tick size
    let precision = 0;
    if (this.tickSize < 1) {
      // Count decimal places in tick size
      const tickStr = this.tickSize.toString();
      const decimalIndex = tickStr.indexOf('.');
      if (decimalIndex !== -1) {
        // Remove trailing zeros to get actual precision
        const decimals = tickStr.substring(decimalIndex + 1).replace(/0+$/, '');
        precision = tickStr.substring(decimalIndex + 1).length;
      }
    }
    
    // Ensure we don't exceed 8 decimal places (Binance max)
    precision = Math.min(precision, 8);
    
    return parseFloat(rounded.toFixed(precision));
  }
  
  private getPrecisionFromMinSize(minSize: number): number {
    if (minSize >= 1) return 0;
    return Math.max(0, Math.ceil(-Math.log10(minSize)));
  }
  
  private calculatePositionSize(): number {
    // Check minimum balance requirement
    if (this.accountBalance < 10) {
      this.log(`Insufficient balance: $${this.accountBalance.toFixed(2)} (need at least $10)`, 'error');
      return 0;
    }
    
    const currentPrice = this.getCurrentPrice();
    if (!currentPrice) {
      this.log('Cannot calculate position size: no current price', 'error');
      return 0;
    }
    
    // Calculate position size based on risk management
    // Risk 2% of account or $10-20 range for market making
    const targetNotional = Math.max(10, Math.min(this.accountBalance * 0.02, 20));
    
    // Calculate raw position size
    const rawSize = targetNotional / currentPrice;
    const rounded = this.roundToStepSize(rawSize);
    
    // Validate notional value (Binance minimum is $5)
    const notional = rounded * currentPrice;
    if (notional < 5) {
      // Force minimum $5.5 notional (with buffer)
      const minSize = this.roundToStepSize(5.5 / currentPrice);
      const minNotional = minSize * currentPrice;
      
      if (minNotional > this.accountBalance * 0.5) {
        this.log(`Cannot meet $5 minimum: would use ${(minNotional/this.accountBalance*100).toFixed(1)}% of balance`, 'error');
        return 0;
      }
      
      this.log(`Position size: ${minSize} ($${minNotional.toFixed(2)}) [minimum]`, 'info');
      return minSize;
    }
    
    this.log(`Position size: ${rounded} ($${notional.toFixed(2)})`, 'info');
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
    const midPrice = (this.lastOrderbook.bids[0].price + this.lastOrderbook.asks[0].price) / 2;
    return midPrice;
  }
  
  private async handleSignal(signal: any) {
    if (!this.tradingEnabled) {
      // Log why we're not trading
      this.log('Trading disabled - ignoring signal', 'warn');
      return;
    }
    
    if (!this.mcpClient) {
      this.log('MCP client not initialized', 'error');
      return;
    }
    
    // Handle MM signals from OrderFlowImbalance
    if (!signal || !signal.type) return;
    
    // Skip MM signals when we have an active position
    if (this.position && this.tradingState === 'POSITION_ACTIVE') {
      // MM signals are for market making, not position management
      return;
    }
    
    // Prevent concurrent signal processing
    if (this.isProcessingSignal) {
      return; // Silently ignore if already processing
    }
    
    // Check cooldown for SETUP signals
    if (signal.type === 'SETUP') {
      const now = Date.now();
      if (now - this.lastSignalTime < this.signalCooldownMs) {
        return; // Too soon, ignore this signal
      }
      this.lastSignalTime = now;
    }
    
    // Set processing flag
    this.isProcessingSignal = true;
    
    try {
      // Handle different signal types
      switch (signal.type) {
        case 'CANCEL':
          if (this.markerOrder) {
            this.log(`CANCEL signal: ${signal.reason || 'Risk detected, cancelling orders'}`, 'warn');
            await this.cancelMarkerOrder();
          }
          // Don't log anything if no orders to cancel
          break;
          
        case 'SETUP':
          // Only act if we're in WATCHING state and don't have existing orders/positions
          if (this.tradingState !== 'WATCHING') {
            // Don't spam logs for repeated signals in wrong state
            if (this.tradingState === 'ORDER_PLACED') {
              // Silently ignore - orders are already placed
              break;
            }
            this.log(`Cannot place orders: wrong state (${this.tradingState})`, 'warn');
            break;
          }
          
          this.log(`SETUP signal detected: ${signal.reason || 'Market making opportunity'}`, 'info');
          
          if (this.markerOrder || this.position) {
            this.log(`Cannot place orders: existing ${this.markerOrder ? 'orders' : 'position'}`, 'warn');
            break; // Use break instead of return
          }
          
          // For market making, we place both bid and ask orders
          const { priceImpactImbalance, orderbookPressure, microstructureFlowImbalance, flowToxicity } = signal.metrics;
          
          // Check if we have valid bid and ask prices from the signal
          if (!signal.bidPrice || !signal.askPrice) {
            this.log('Invalid signal: missing bid/ask prices', 'error');
            break; // Use break instead of return
          }
          
          // Place both bid and ask orders for market making
          await this.placeMarketMakingOrders({
            bidPrice: signal.bidPrice,
            askPrice: signal.askPrice,
            reason: signal.reason || `MM signal: ${signal.type}`
          });
          break;
      }
    } finally {
      // Always clear the processing flag
      this.isProcessingSignal = false;
    }
  }
  
  private async placeMarketMakingOrders(params: { bidPrice: number, askPrice: number, reason: string }) {
    if (!this.mcpClient) {
      this.log('Cannot place orders: MCP client not connected', 'error');
      return;
    }
    
    // Double-check state to prevent race conditions
    if (this.tradingState !== 'WATCHING') {
      return; // Silently exit if state changed
    }
    
    if (this.markerOrder) {
      this.log('Already have pending orders', 'warn');
      return;
    }
    
    if (this.position) {
      this.log('Already have active position', 'warn');
      return;
    }
    
    const operationKey = `marker_order_${this.symbol}`;
    if (!this.backoff.canAttempt(operationKey)) {
      this.log('Order placement in backoff', 'warn');
      return;
    }
    
    const positionSize = this.calculatePositionSize();
    if (positionSize === 0) {
      return; // Error already logged in calculatePositionSize
    }
    
    try {
      // Round prices to tick size
      const roundedBidPrice = this.roundToTickSize(params.bidPrice);
      const roundedAskPrice = this.roundToTickSize(params.askPrice);
      
      // Double-check notional values
      const bidNotional = positionSize * roundedBidPrice;
      const askNotional = positionSize * roundedAskPrice;
      
      this.log(`Placing MM orders: Size=${positionSize}, Bid @ ${roundedBidPrice.toFixed(this.pricePrecision)} ($${bidNotional.toFixed(2)}), Ask @ ${roundedAskPrice.toFixed(this.pricePrecision)} ($${askNotional.toFixed(2)})`, 'info');
      
      // Place bid order
      const bidResult = await this.mcpClient.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.symbol,
          side: 'BUY',
          type: 'LIMIT',
          quantity: positionSize,
          price: roundedBidPrice,
          timeInForce: 'GTX' // Post-only
        }
      });
      
      const bidResponseText = (bidResult.content as any)[0].text;
      let bidOrderId: string | undefined;
      
      if (!bidResponseText.includes('error')) {
        const bidOrder = JSON.parse(bidResponseText);
        bidOrderId = bidOrder.orderId;
        this.log(`Bid order placed: #${bidOrderId}`, 'success');
      } else {
        const errorData = JSON.parse(bidResponseText);
        this.log(`Bid order failed: ${errorData.error}`, 'error');
      }
      
      // Place ask order
      const askResult = await this.mcpClient.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.symbol,
          side: 'SELL',
          type: 'LIMIT',
          quantity: positionSize,
          price: roundedAskPrice,
          timeInForce: 'GTX' // Post-only
        }
      });
      
      const askResponseText = (askResult.content as any)[0].text;
      let askOrderId: string | undefined;
      
      if (!askResponseText.includes('error')) {
        const askOrder = JSON.parse(askResponseText);
        askOrderId = askOrder.orderId;
        this.log(`Ask order placed: #${askOrderId}`, 'success');
      } else {
        const errorData = JSON.parse(askResponseText);
        this.log(`Ask order failed: ${errorData.error}`, 'error');
      }
      
      // If at least one order was placed successfully
      if (bidOrderId || askOrderId) {
        // Set state FIRST to prevent race conditions
        this.tradingState = 'ORDER_PLACED';
        
        this.markerOrder = {
          bidOrderId,
          askOrderId,
          symbol: this.symbol,
          bidPrice: params.bidPrice,
          askPrice: params.askPrice,
          size: positionSize,
          status: 'NEW'
        };
        
        this.log(`MM orders active: Bid=${!!bidOrderId}, Ask=${!!askOrderId}`, 'success');
        this.backoff.recordSuccess(operationKey);
      } else {
        this.log('Failed to place any orders', 'error');
        this.backoff.recordFailure(operationKey);
      }
      
    } catch (error: any) {
      this.log(`Order placement error: ${error.message || error}`, 'error');
      this.backoff.recordFailure(operationKey);
    }
  }
  
  private async cancelMarkerOrder() {
    if (!this.mcpClient || !this.markerOrder) return;
    
    try {
      // Cancel bid order if exists
      if (this.markerOrder.bidOrderId) {
        try {
          await this.mcpClient.callTool({
            name: 'cancel_order',
            arguments: {
              symbol: this.markerOrder.symbol,
              orderId: this.markerOrder.bidOrderId
            }
          });
          this.log(`Cancelled bid order #${this.markerOrder.bidOrderId}`, 'info');
        } catch (error) {
          this.log(`Failed to cancel bid: ${error}`, 'error');
        }
      }
      
      // Cancel ask order if exists
      if (this.markerOrder.askOrderId) {
        try {
          await this.mcpClient.callTool({
            name: 'cancel_order',
            arguments: {
              symbol: this.markerOrder.symbol,
              orderId: this.markerOrder.askOrderId
            }
          });
          this.log(`Cancelled ask order #${this.markerOrder.askOrderId}`, 'info');
        } catch (error) {
          this.log(`Failed to cancel ask: ${error}`, 'error');
        }
      }
      
      this.markerOrder = null;
      this.tradingState = 'WATCHING';
    } catch (error) {
      this.log(`Failed to cancel orders: ${error}`, 'error');
    }
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
        this.log(`SL order placed #${slOrder.orderId} @ ${this.position.slPrice.toFixed(this.pricePrecision)}`, 'success');
      }
    } catch (error) {
      this.log(`Failed to place SL order: ${error}`, 'error');
    }
  }
  
  private async placeTPOrder() {
    if (!this.mcpClient || !this.position || !this.position.tpPrice) return;
    
    try {
      const result = await this.mcpClient.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'LIMIT',
          quantity: this.position.size,
          price: this.position.tpPrice,
          timeInForce: 'GTX', // Post-only for maker fees
          reduceOnly: true
        }
      });
      
      const responseText = (result.content as any)[0].text;
      
      if (!responseText.includes('error')) {
        const tpOrder = JSON.parse(responseText);
        this.position.tpOrderId = tpOrder.orderId;
        this.log(`TP order placed #${tpOrder.orderId} @ ${this.position.tpPrice.toFixed(this.pricePrecision)}`, 'success');
      } else {
        // If post-only fails, try regular limit order
        const retryResult = await this.mcpClient.callTool({
          name: 'place_order',
          arguments: {
            symbol: this.position.symbol,
            side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'LIMIT',
            quantity: this.position.size,
            price: this.position.tpPrice,
            timeInForce: 'GTC',
            reduceOnly: true
          }
        });
        
        const retryResponseText = (retryResult.content as any)[0].text;
        if (!retryResponseText.includes('error')) {
          const tpOrder = JSON.parse(retryResponseText);
          this.position.tpOrderId = tpOrder.orderId;
          this.log(`TP order placed #${tpOrder.orderId} @ ${this.position.tpPrice.toFixed(this.pricePrecision)} (taker)`, 'success');
        }
      }
    } catch (error) {
      this.log(`Failed to place TP order: ${error}`, 'error');
    }
  }
  
  private async placePositionOrders() {
    if (!this.position) return;
    
    this.log('Placing position management orders...', 'info');
    
    // Place both SL and TP orders
    await Promise.all([
      this.placeSLOrder(),
      this.placeTPOrder()
    ]);
  }
  
  private async ensurePositionOrders() {
    if (!this.position) return;
    
    const needsSL = !this.position.slOrderId;
    const needsTP = this.position.tpPrice && !this.position.tpOrderId;
    
    if (needsSL || needsTP) {
      this.log('Position orders missing, placing now...', 'warn');
      if (needsSL) await this.placeSLOrder();
      if (needsTP) await this.placeTPOrder();
    }
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
    
    lines.push(`{bold}Mode:{/bold} {green-fg}LIVE TRADING{/green-fg}`);
    
    // Show descriptive state
    let stateDisplay = this.tradingState;
    let stateColor = 'white-fg';
    switch (this.tradingState) {
      case 'IDLE':
        stateDisplay = 'IDLE - Initializing';
        stateColor = 'gray-fg';
        break;
      case 'WATCHING':
        stateDisplay = 'WATCHING - Ready for signals';
        stateColor = 'cyan-fg';
        break;
      case 'ORDER_PLACED':
        stateDisplay = 'ORDER_PLACED - MM orders active';
        stateColor = 'yellow-fg';
        break;
      case 'POSITION_ACTIVE':
        stateDisplay = 'POSITION_ACTIVE - Managing position';
        stateColor = 'green-fg';
        break;
      case 'CLOSING':
        stateDisplay = 'CLOSING - Exiting position';
        stateColor = 'magenta-fg';
        break;
      case 'ERROR':
        stateDisplay = 'ERROR - Check logs';
        stateColor = 'red-fg';
        break;
    }
    lines.push(`{bold}State:{/bold} {${stateColor}}${stateDisplay}{/${stateColor}}`);
    lines.push(`{bold}Balance:{/bold} $${this.accountBalance.toFixed(2)}`);
    lines.push('');
    
    if (this.position) {
      lines.push('{bold}Position:{/bold}');
      lines.push(`Side: ${this.position.side}`);
      lines.push(`Entry: ${this.position.entryPrice.toFixed(this.pricePrecision)}`);
      lines.push(`Size: ${this.position.size}`);
      lines.push(`SL: ${this.position.slPrice.toFixed(this.pricePrecision)}${this.position.slOrderId ? ' ✓' : ' ⚠'}`);
      if (this.position.tpPrice) {
        lines.push(`TP: ${this.position.tpPrice.toFixed(this.pricePrecision)}${this.position.tpOrderId ? ' ✓' : ' ⚠'}`);
      }
      
      const currentPrice = this.getCurrentPrice();
      if (currentPrice) {
        const pnl = this.position.side === 'LONG'
          ? (currentPrice - this.position.entryPrice) * this.position.size
          : (this.position.entryPrice - currentPrice) * this.position.size;
        const pnlBps = (pnl / (this.position.entryPrice * this.position.size)) * 10000;
        lines.push(`PnL: ${pnl >= 0 ? '{green-fg}' : '{red-fg}'}${pnl.toFixed(2)} (${pnlBps.toFixed(1)}bps){/}`);
      }
    } else if (this.markerOrder) {
      lines.push('{bold}Market Making Orders:{/bold}');
      if (this.markerOrder.bidOrderId && this.markerOrder.bidPrice) {
        const bidId = String(this.markerOrder.bidOrderId);
        lines.push(`Bid: ${this.markerOrder.bidPrice.toFixed(this.pricePrecision)} #${bidId.slice(-6)}`);
      }
      if (this.markerOrder.askOrderId && this.markerOrder.askPrice) {
        const askId = String(this.markerOrder.askOrderId);
        lines.push(`Ask: ${this.markerOrder.askPrice.toFixed(this.pricePrecision)} #${askId.slice(-6)}`);
      }
      lines.push(`Size: ${this.markerOrder.size}`);
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
        // Only log non-CANCEL signals, or CANCEL if we have orders
        if (signal.type !== 'CANCEL' || this.markerOrder) {
          // Fire and forget - don't await to avoid blocking UI updates
          this.handleSignal(signal).catch(error => {
            this.log(`Error handling signal: ${error}`, 'error');
          });
        }
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
      
      // Wrap trading status update in try-catch since it can have formatting errors
      try {
        this.tradingBox.setContent(this.formatTradingStatus());
      } catch (statusError) {
        // Don't crash the whole update, just log the error
        this.tradingBox.setContent('{bold}Mode:{/bold} {green-fg}LIVE TRADING{/green-fg}\n{bold}State:{/bold} ' + this.tradingState);
      }
      
      // Render screen
      this.screen.render();
    } catch (error) {
      // Use our log method instead of console.error
      this.log(`Display update error: ${error}`, 'error');
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
    .option('-d, --depth <levels>', 'Orderbook depth levels', '20');
  
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
    options.avgSpread
  );
  
  try {
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
    
    // Connect websocket first
    await ws.connect();
    
    // Set up global error handlers before suppressing console
    process.on('uncaughtException', (error) => {
      tui.log(`Uncaught Exception: ${error.message}`, 'error');
      if (error.stack) {
        tui.log(`Stack: ${error.stack.split('\n')[1]}`, 'error');
      }
    });
    
    process.on('unhandledRejection', (reason: any, promise) => {
      tui.log(`Unhandled Rejection: ${reason}`, 'error');
    });
    
    // Only suppress console output after everything is initialized
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    
    // Redirect console to logs panel
    console.log = (...args) => {
      tui.log(args.join(' '), 'info');
    };
    console.error = (...args) => {
      tui.log(args.join(' '), 'error');
    };
    console.warn = (...args) => {
      tui.log(args.join(' '), 'warn');
    };
    
    // Start the TUI
    tui.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);