#!/usr/bin/env -S npx tsx
/**
 * === liquidity scalping strategy v0.2.0 ===
 *
 * This is a self-contained liquidity scalping strategy cli program driven by dynamic orderbooks.
 * Our client is using standard mcp client that integrates mcpServers/binance.ts mcp server.
 * Internally, we have a state-machine to manage states and the current state.
 *
 * 1. We look for suitable markets that have proper Volatility (ATR) and Liquidity (Spread).
 *    Using `get_top_symbols` with 40bps <= atr_bps_5m <= 80bps sorted by atr_bps_5m aesc.
 * 2. If there's no active positions. It's entry-hunting mode - We choose the first market in the results
 *    and subscribe orderbook websocket events to look for entry opportunities (check OrderbookDynamics.ts):
 *      - If there's no marker order and spread spread_ticks > 1 (there's a spread gap):
 *          <> If there's bids LIQUIDITY_SURGE or asks LIQUIDITY_WITHDRAWAL, we create a long marker-only bids order just below best_ask;
 *          <> If there's asks LIQUIDITY_SURGE or bids LIQUIDITY_WITHDRAWAL, we create a short marker-only asks order just above best_bid.
 *          If marker-only order can't be placed, we wait for next chance.
 *      - If thre're an active marker order:
 *          <> If received any MARKET_MAKER_SHIFT event, cancel the order;
 *          <> If our active marker order is long, and LIQUIDITY_SURGE is asks or LIQUIDITY_WITHDRAWAL is bids, cancel the order;
 *          <> If our active marker order is short, and LIQUIDITY_SURGE is bids or LIQUIDITY_WITHDRAWAL is asks, cancel the order.
 * 3. Once a new position open:
 *      <> TP: we set TP to an atr_bps_5m above or below immediately. It should be a marker-only order.
 *      <> SL: we set SL to a half of an atr_bps_5m above or below immediately. It should be a market order.
 * 4. When we have an active position, keep monitoring the price:
 * 5. Loop above steps, if we are in entry-hunting mode, just to make sure we entry following rules listed above.
 *
 * Position Management:
 *  <> 30% Rule: Risk per trade never exceeds 30%, use calculate_position_size for position calculation
 *  <> TP/SL: Set immediately after entry, no exceptions
 *  <> R:R = 0.5ATR : ATR = 0.5
 *  <> Position Limit: Maximum 1 concurrent position
 */

import { Client } from '@modelcontextprotocol/sdk/client/index'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import chalk from 'chalk'
import { Command } from 'commander'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { OrderbookDynamics } from '../analysis/OrderbookDynamics'
import { DynamicPattern, OrderbookSnapshot, TradingConfig } from '../types/orderbook'
import { BinanceWebsocket } from '../websocket/BinanceWebsocket'
import { BinanceUserDataWS, AccountUpdate, OrderUpdate } from '../websocket/BinanceUserDataWS'
import { ExponentialBackoff } from '../utils/ExponentialBackoff'

dayjs.extend(utc)

// State machine states
type State = 'INITIALIZING' | 'SEARCHING_MARKET' | 'ENTRY_HUNTING' | 'POSITION_ACTIVE' | 'ERROR'

// Position types
interface Position {
  symbol: string
  side: 'LONG' | 'SHORT'
  entryPrice: number
  size: number
  originalSize: number  // Track original position size
  entryTime: number
  tpOrderId?: string
  slOrderId?: string
  tpPrice: number
  slPrice: number
  unrealizedPnl?: number
}

// Market order types
interface MarkerOrder {
  orderId: string
  symbol: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  timeInForce: 'GTX' // Post-only
}

// Market data
interface MarketData {
  symbol: string
  atrBps: number
  atrValue: number
  price: number
  tickSize: number
  minOrderSize: number
  stepSize: number  // Add step size for quantity precision
  volumeUSDT24h: number
}

class LiquidityScalpingStrategy {
  private state: State = 'INITIALIZING'
  private mcpClient: Client | null = null
  private websocket: BinanceWebsocket | null = null
  private userDataWS: BinanceUserDataWS | null = null
  private orderbookDynamics: OrderbookDynamics | null = null
  private position: Position | null = null
  private markerOrder: MarkerOrder | null = null
  private currentMarket: MarketData | null = null
  private accountBalance: number = 0
  private lastPatternCheckTime: number = 0
  private patternCheckInterval: number = 1000 // Check patterns only once per second
  private positionStartTime: number = 0
  // private exitTimeouts: NodeJS.Timeout[] = [] // Removed - no time-based exits
  private orderMonitorInterval: NodeJS.Timeout | null = null
  private lastPositionCheck: number = 0
  private positionCheckInterval: number = 2000 // Check position status every 2 seconds
  private lastTPSLCheck: number = 0
  private lastMarketEvaluation: number = 0
  private tpslCheckInterval: number = 5000 // Check TP/SL orders every 5 seconds
  private lastOrderPlacement: number = 0 // Track when we last placed orders
  // Cleanup interval for dangling orders
  private cleanupInterval: NodeJS.Timeout | null = null
  
  // General exponential backoff for all operations
  private backoff: ExponentialBackoff

  constructor() {
    // Initialize with 3s base, 60s max, 2x multiplier
    this.backoff = new ExponentialBackoff(3000, 60000, 2)
  }

  async start() {
    try {
      console.log(chalk.cyan('=== Liquidity Scalping Strategy v0.2.0 ==='))
      console.log(chalk.yellow('Mode: LIVE TRADING'))
      
      await this.initializeMCPClient()
      await this.getAccountInfo()
      
      // Initialize user data WebSocket for real-time position updates
      await this.initializeUserDataWS()
      
      // Check for existing positions
      const hasExistingPosition = await this.checkExistingPositions()
      
      if (hasExistingPosition) {
        this.state = 'POSITION_ACTIVE'
        console.log(chalk.yellow('\n⚡ Resuming management of existing position'))
      } else {
        this.state = 'SEARCHING_MARKET'
      }
      
      // No longer needed - using WebSocket for real-time updates
      // setInterval(() => this.syncPositionState(), 5000)
      
      await this.mainLoop()
    } catch (error) {
      console.error(chalk.red('Fatal error:'), error)
      this.state = 'ERROR'
      await this.cleanup()
    }
  }

  private async initializeMCPClient() {
    console.log(chalk.gray('Initializing MCP client...'))
    
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcpServers/binance.ts']
    })
    
    this.mcpClient = new Client({
      name: 'liquidity-scalping',
      version: '0.2.0'
    }, {
      capabilities: {}
    })
    
    await this.mcpClient.connect(transport)
    console.log(chalk.green('✓ MCP client connected'))
  }

  private async getAccountInfo() {
    const result = await this.mcpClient!.callTool({
      name: 'get_account',
      arguments: {}
    })
    
    const response = JSON.parse((result.content as any)[0].text)
    
    // Debug log the response structure
    console.log(chalk.gray('Account response structure:', JSON.stringify(Object.keys(response))))
    
    // Handle different response structures
    const account = response.account || response
    
    // Check if we have assets array
    if (account.assets && Array.isArray(account.assets)) {
      // Find USDC balance
      const usdcAsset = account.assets.find((a: any) => a.asset === 'USDC')
      if (usdcAsset) {
        this.accountBalance = parseFloat(usdcAsset.availableBalance || usdcAsset.free || '0')
      } else {
        // Sum all available balances
        this.accountBalance = account.assets.reduce((sum: number, asset: any) => {
          return sum + parseFloat(asset.availableBalance || asset.free || '0')
        }, 0)
      }
    } else if (account.balances && Array.isArray(account.balances)) {
      // Alternative structure with balances array
      const usdcBalance = account.balances.find((b: any) => b.asset === 'USDC')
      if (usdcBalance) {
        this.accountBalance = parseFloat(usdcBalance.free || usdcBalance.availableBalance || '0')
      } else {
        // Sum all free balances
        this.accountBalance = account.balances.reduce((sum: number, balance: any) => {
          return sum + parseFloat(balance.free || balance.availableBalance || '0')
        }, 0)
      }
    } else {
      // Fallback to direct fields
      this.accountBalance = parseFloat(account.availableBalance || account.totalWalletBalance || '0')
    }
    
    // Show more detailed balance info
    console.log(chalk.green(`✓ Account balance:`))
    console.log(chalk.gray(`  Available: $${this.accountBalance.toFixed(2)}`))
    console.log(chalk.gray(`  Total Wallet: $${parseFloat(account.totalWalletBalance || '0').toFixed(2)}`))
    if (account.totalUnrealizedProfit && parseFloat(account.totalUnrealizedProfit) !== 0) {
      console.log(chalk.gray(`  Unrealized PnL: $${parseFloat(account.totalUnrealizedProfit).toFixed(2)}`))
    }
    
    // Warning for low balance but don't block trading
    if (this.accountBalance < 20) {
      console.log(chalk.yellow(`\n⚠️  Low balance: $${this.accountBalance.toFixed(2)} - position sizes will be limited by $5 minimum notional`))
    }
  }
  
  private async initializeUserDataWS() {
    console.log(chalk.gray('Initializing user data stream...'))
    
    this.userDataWS = new BinanceUserDataWS(
      this.mcpClient!,
      (data) => this.handleUserDataUpdate(data)
    )
    
    await this.userDataWS.connect()
    console.log(chalk.green(`✓ User data stream connected`))
    
    // Start periodic cleanup of dangling orders
    this.startPeriodicCleanup()
  }
  
  private async handleUserDataUpdate(data: AccountUpdate | OrderUpdate) {
    if (data.eventType === 'ACCOUNT_UPDATE') {
      // Handle account updates (positions, balances)
      await this.handleAccountUpdate(data)
    } else if (data.eventType === 'ORDER_TRADE_UPDATE') {
      // Handle order updates
      this.handleOrderUpdate(data)
    }
  }
  
  private async handleAccountUpdate(update: AccountUpdate) {
    // Update account balance
    const usdcBalance = update.balances.find(b => b.asset === 'USDC')
    if (usdcBalance) {
      const newBalance = parseFloat(usdcBalance.walletBalance)
      if (newBalance !== this.accountBalance) {
        console.log(chalk.gray(`  💰 Balance updated: $${newBalance.toFixed(2)}`))
        this.accountBalance = newBalance
      }
    }
    
    // Check position updates
    if (this.position && this.currentMarket) {
      const positionUpdate = update.positions.find(p => p.symbol === this.currentMarket!.symbol)
      
      if (positionUpdate) {
        const posAmt = parseFloat(positionUpdate.positionAmt)
        
        // Position closed
        if (posAmt === 0) {
          const pnl = this.calculatePnlBps()
          const unRealizedProfit = parseFloat(positionUpdate.unRealizedProfit)
          
          console.log(chalk.green(`\n✓ Position closed via WebSocket (PnL: ${pnl.toFixed(1)}bps, $${unRealizedProfit.toFixed(2)})`))
          console.log(chalk.gray(`  Entry: ${this.position.entryPrice.toFixed(4)}`))
          console.log(chalk.gray(`  Mark Price: ${positionUpdate.markPrice}`))
          
          // Clear position and cancel all pending orders
          await this.cancelPendingOrders()
          await this.switchToEntryHunting()
        }
        // Position size changed (partial exit)
        else if (Math.abs(posAmt) !== this.position.size && posAmt !== 0) {
          const oldSize = this.position.size
          this.position.size = Math.abs(posAmt)
          console.log(chalk.yellow(`  📊 Position size changed: ${oldSize} → ${this.position.size}`))
        }
      } else {
        // No position update for our symbol means position is closed
        console.log(chalk.yellow(`\n⚠️  Position not found in WebSocket update - assuming closed`))
        
        // Clear position and cancel all pending orders
        await this.cancelPendingOrders()
        await this.switchToEntryHunting()
      }
    }
  }
  
  private handleOrderUpdate(update: OrderUpdate) {
    // Log important order events
    if (update.orderStatus === 'FILLED') {
      console.log(chalk.green(`  ✅ Order FILLED: ${update.side} ${update.originalQuantity} @ ${update.averagePrice}`))
      
      // Check if this is our TP order
      if (this.position && update.orderId === parseInt(this.position.tpOrderId || '0')) {
        console.log(chalk.green(`  🎯 Take Profit hit!`))
      }
      // Check if this is our SL order
      else if (this.position && update.orderId === parseInt(this.position.slOrderId || '0')) {
        console.log(chalk.red(`  🛑 Stop Loss hit!`))
      }
    } else if (update.orderStatus === 'CANCELED') {
      // Check if important orders were cancelled
      if (this.position) {
        if (update.orderId === parseInt(this.position.tpOrderId || '0')) {
          console.log(chalk.yellow(`  ⚠️  TP order cancelled`))
          this.position.tpOrderId = undefined
        } else if (update.orderId === parseInt(this.position.slOrderId || '0')) {
          console.log(chalk.yellow(`  ⚠️  SL order cancelled`))
          this.position.slOrderId = undefined
        }
      }
    } else if (update.orderStatus === 'NEW') {
      console.log(chalk.gray(`  📝 New order: ${update.side} ${update.originalQuantity} @ ${update.originalPrice}`))
    }
  }

  private async checkExistingPositions(): Promise<boolean> {
    try {
      const result = await this.mcpClient!.callTool({
        name: 'get_positions',
        arguments: {}
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      const positions = response.positions || []
      
      // Find any open position
      const openPosition = positions.find((p: any) => 
        p.positionAmt && Math.abs(parseFloat(p.positionAmt)) > 0
      )
      
      if (openPosition) {
        console.log(chalk.yellow(`\n📊 Found existing position:`))
        console.log(chalk.gray(`  Symbol: ${openPosition.symbol}`))
        console.log(chalk.gray(`  Side: ${parseFloat(openPosition.positionAmt) > 0 ? 'LONG' : 'SHORT'}`))
        console.log(chalk.gray(`  Size: ${Math.abs(parseFloat(openPosition.positionAmt))}`))
        console.log(chalk.gray(`  Entry: ${openPosition.entryPrice}`))
        console.log(chalk.gray(`  PnL: ${parseFloat(openPosition.unRealizedProfit).toFixed(2)} USDT`))
        
        // Reconstruct position object
        const positionAmt = parseFloat(openPosition.positionAmt)
        const side = positionAmt > 0 ? 'LONG' : 'SHORT'
        const entryPrice = parseFloat(openPosition.entryPrice)
        
        // Get market info for this symbol
        await this.getMarketInfoForSymbol(openPosition.symbol)
        
        // Calculate ATR-based TP/SL
        const atrValue = this.currentMarket!.atrValue
        
        // Initialize orderbook first to get current spread for TP calculation
        await this.initializeOrderbook()
        
        // Get current orderbook for TP calculation
        const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
        let tpPrice: number
        
        if (orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0) {
          const bestBid = orderbook.bids[0].price
          const bestAsk = orderbook.asks[0].price
          const tickSize = this.currentMarket!.tickSize
          
          if (side === 'LONG') {
            // For LONG: We want to sell at the highest price that won't cross the spread
            // Start with ATR-based target
            const atrBasedTP = entryPrice + (atrValue * 0.5)
            
            // Ensure we're not crossing the spread - must be >= best_ask to be a maker order
            if (atrBasedTP < bestAsk) {
              // If ATR target is below best ask, place at best ask (join the queue)
              tpPrice = this.roundToTickSize(bestAsk)
            } else {
              // If ATR target is above best ask, use it (will be in the book as maker)
              tpPrice = this.roundToTickSize(atrBasedTP)
            }
            
            // Also ensure minimum profit of at least 2 ticks
            const minTP = entryPrice + (tickSize * 2)
            tpPrice = Math.max(tpPrice, minTP)
            
          } else {
            // For SHORT: We want to buy at the lowest price that won't cross the spread
            // Start with ATR-based target
            const atrBasedTP = entryPrice - (atrValue * 0.5)
            
            // Ensure we're not crossing the spread - must be <= best_bid to be a maker order
            if (atrBasedTP > bestBid) {
              // If ATR target is above best bid, place at best bid (join the queue)
              tpPrice = this.roundToTickSize(bestBid)
            } else {
              // If ATR target is below best bid, use it (will be in the book as maker)
              tpPrice = this.roundToTickSize(atrBasedTP)
            }
            
            // Also ensure minimum profit of at least 2 ticks
            const minTP = entryPrice - (tickSize * 2)
            tpPrice = Math.min(tpPrice, minTP)
          }
        } else {
          // Fallback to ATR-based TP if no orderbook data
          tpPrice = this.roundToTickSize(
            side === 'LONG' 
              ? entryPrice + (atrValue * 0.5)
              : entryPrice - (atrValue * 0.5)
          )
        }
        
        this.position = {
          symbol: openPosition.symbol,
          side,
          entryPrice,
          size: Math.abs(positionAmt),
          originalSize: Math.abs(positionAmt), // Assume current size is original
          entryTime: Date.now() - 60000, // Assume 1 minute old if unknown
          tpPrice,
          slPrice: this.roundToTickSize(
            side === 'LONG'
              ? entryPrice - atrValue  // SL at 1 ATR
              : entryPrice + atrValue
          ),
          unrealizedPnl: parseFloat(openPosition.unRealizedProfit)
        }
        
        // Check for existing TP/SL orders
        await this.checkExistingTPSLOrders()
        
        // Exit timers removed - using only TP/SL
        
        return true
      }
      
      return false
    } catch (error) {
      console.error(chalk.red('Error checking existing positions:'), error)
      return false
    }
  }

  private async getMarketInfoForSymbol(symbol: string) {
    try {
      // Get symbol info from top symbols
      const result = await this.mcpClient!.callTool({
        name: 'get_top_symbols',
        arguments: {
          minAtrBps: 1,
          maxAtrBps: 1000,
          limit: 100
        }
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      const symbols = response.symbols || []
      const symbolInfo = symbols.find((s: any) => s.symbol === symbol)
      
      if (symbolInfo) {
        this.currentMarket = {
          symbol: symbolInfo.symbol,
          atrBps: Math.round(symbolInfo.atr_bps_5m),
          atrValue: symbolInfo.atr_quote_5m,
          price: parseFloat(symbolInfo.last_price),
          tickSize: symbolInfo.tick_size,
          minOrderSize: 0.001,
          stepSize: 0.001, // Default, will be updated from exchange info
          volumeUSDT24h: parseFloat(symbolInfo.quote_volume)
        }
      } else {
        // Fallback: estimate ATR as 0.5% of price
        const tickerResult = await this.mcpClient!.callTool({
          name: 'get_ticker_24hr',
          arguments: { symbol }
        })
        const ticker = JSON.parse((tickerResult.content as any)[0].text)
        const price = parseFloat(ticker.lastPrice)
        
        this.currentMarket = {
          symbol,
          atrBps: 50, // Default 50 bps
          atrValue: price * 0.005,
          price,
          tickSize: 0.0001, // Default tick size
          minOrderSize: 0.001,
          stepSize: 0.001, // Default step size
          volumeUSDT24h: parseFloat(ticker.quoteVolume)
        }
      }
      
      // Get proper exchange info
      await this.getExchangeInfo()
      
      console.log(chalk.gray(`  Market ATR: ${this.currentMarket.atrBps}bps ($${this.currentMarket.atrValue.toFixed(4)})`))
    } catch (error) {
      console.error(chalk.red('Error getting market info:'), error)
      throw error
    }
  }

  private async checkExistingTPSLOrders() {
    try {
      const result = await this.mcpClient!.callTool({
        name: 'get_open_orders',
        arguments: {
          symbol: this.position!.symbol
        }
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      const orders = response.orders || []
      
      // Look for TP and SL orders
      for (const order of orders) {
        if (order.reduceOnly) {
          if (order.type === 'LIMIT') {
            // This is likely a TP order
            this.position!.tpOrderId = order.orderId
            this.position!.tpPrice = parseFloat(order.price)
            console.log(chalk.gray(`  Found existing TP order #${order.orderId} at ${order.price}`))
          } else if (order.type === 'STOP_MARKET' || order.type === 'STOP') {
            // This is likely a SL order
            this.position!.slOrderId = order.orderId
            this.position!.slPrice = parseFloat(order.stopPrice)
            console.log(chalk.gray(`  Found existing SL order #${order.orderId} at ${order.stopPrice}`))
          }
        }
      }
      
      if (!this.position!.tpOrderId) {
        console.log(chalk.yellow('  ⚠️  No TP order found'))
      }
      if (!this.position!.slOrderId) {
        console.log(chalk.yellow('  ⚠️  No SL order found'))
      }
    } catch (error) {
      console.warn(chalk.yellow('Could not check existing orders:'), error)
    }
  }

  private async mainLoop() {
    while (this.state !== 'ERROR') {
      // Check if balance is too low to trade
      if (this.accountBalance < 5 && !this.position) {
        console.log(chalk.red(`\n❌ Cannot trade with balance $${this.accountBalance.toFixed(2)} (minimum $5 required)`))
        console.log(chalk.yellow('⏸️  Pausing for 30 seconds...'))
        await new Promise(resolve => setTimeout(resolve, 30000))
        
        // Re-fetch account info
        await this.getAccountInfo()
        continue
      }
      
      // Double-check state consistency
      if (this.position && this.state !== 'POSITION_ACTIVE') {
        console.log(chalk.yellow('⚠️  State mismatch: Have position but not in POSITION_ACTIVE state'))
        this.state = 'POSITION_ACTIVE'
      } else if (!this.position && this.state === 'POSITION_ACTIVE') {
        console.log(chalk.yellow('⚠️  State mismatch: No position but in POSITION_ACTIVE state'))
        this.state = 'ENTRY_HUNTING'
      }
      
      switch (this.state) {
        case 'SEARCHING_MARKET':
          await this.searchForMarket()
          break
        case 'ENTRY_HUNTING':
          await this.huntForEntry()
          break
        case 'POSITION_ACTIVE':
          await this.managePosition()
          break
      }
      
      // Small delay to prevent CPU overload
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  private async searchForMarket() {
    console.log(chalk.cyan('\nSearching for suitable market...'))
    
    const result = await this.mcpClient!.callTool({
      name: 'get_top_symbols',
      arguments: {
        minAtrBps: 40,
        maxAtrBps: 80,
        limit: 10
      }
    })
    
    const response = JSON.parse((result.content as any)[0].text)
    const symbols = response.symbols || []
    if (symbols.length === 0) {
      console.log(chalk.yellow('No suitable markets found. Retrying in 30s...'))
      await new Promise(resolve => setTimeout(resolve, 30000))
      return
    }
    
    // Select the first symbol
    const selected = symbols[0]
    this.currentMarket = {
      symbol: selected.symbol,
      atrBps: Math.round(selected.atr_bps_5m),
      atrValue: selected.atr_quote_5m,
      price: parseFloat(selected.last_price),
      tickSize: selected.tick_size,
      minOrderSize: 0.001, // Default for most pairs
      stepSize: 0.001, // Default step size
      volumeUSDT24h: parseFloat(selected.quote_volume)
    }
    
    // Mark market evaluation time
    this.lastMarketEvaluation = Date.now()
    
    console.log(chalk.green(`✓ Selected market: ${this.currentMarket.symbol}`))
    console.log(chalk.gray(`  ATR: ${this.currentMarket.atrBps}bps ($${this.currentMarket.atrValue.toFixed(4)})`))
    console.log(chalk.gray(`  Volume 24h: $${(this.currentMarket.volumeUSDT24h / 1e6).toFixed(2)}M`))
    
    // Get proper exchange info for the symbol
    await this.getExchangeInfo()
    await this.initializeOrderbook()
    this.state = 'ENTRY_HUNTING'
  }

  private async getExchangeInfo() {
    try {
      const result = await this.mcpClient!.callTool({
        name: 'get_exchange_info',
        arguments: {
          symbol: this.currentMarket!.symbol
        }
      })
      
      const info = JSON.parse((result.content as any)[0].text)
      
      // Update minOrderSize and stepSize from exchange info
      const lotSizeFilter = info.filters.find((f: any) => f.filterType === 'LOT_SIZE')
      if (lotSizeFilter) {
        this.currentMarket!.minOrderSize = parseFloat(lotSizeFilter.minQty)
        this.currentMarket!.stepSize = parseFloat(lotSizeFilter.stepSize)
        console.log(chalk.gray(`  Exchange info: minQty=${lotSizeFilter.minQty}, stepSize=${lotSizeFilter.stepSize}`))
      }
    } catch (error) {
      console.warn(chalk.yellow('Failed to get exchange info, using default min order size'))
    }
  }

  private async switchToEntryHunting() {
    this.position = null
    this.clearExitTimers()
    this.state = 'ENTRY_HUNTING'
    this.lastPatternCheckTime = Date.now() + 5000 // 5 second cooldown
    console.log(chalk.cyan('🎯 Switching to ENTRY HUNTING mode'))
    
    // Only re-evaluate markets if it's been more than 5 minutes since last evaluation
    const now = Date.now()
    const timeSinceLastEval = now - this.lastMarketEvaluation
    
    if (timeSinceLastEval < 300000) { // 5 minutes
      console.log(chalk.gray(`  Keeping current market ${this.currentMarket?.symbol} (evaluated ${Math.floor(timeSinceLastEval / 60000)}m ago)`))
      return
    }
    
    // Re-evaluate market opportunities
    console.log(chalk.yellow('\n📊 Re-evaluating market opportunities...'))
    
    try {
      // Clean up existing websocket
      if (this.websocket) {
        this.websocket.disconnect()
        this.websocket = null
      }
      
      if (this.orderbookDynamics) {
        this.orderbookDynamics.reset()
        this.orderbookDynamics = null
      }
      
      // Get fresh top symbols
      const topSymbolsResult = await this.mcpClient!.callTool({
        name: 'get_top_symbols',
        arguments: {
          minAtrBps: 40,
          maxAtrBps: 80,
          limit: 10
        }
      })
      
      const topSymbols = JSON.parse((topSymbolsResult.content as any)[0].text)
      
      if (!topSymbols.symbols || topSymbols.symbols.length === 0) {
        console.log(chalk.red('No suitable symbols found'))
        return
      }
      
      // Select the first suitable symbol
      const selected = topSymbols.symbols[0]
      this.currentMarket = {
        symbol: selected.symbol,
        atrBps: Math.round(selected.atr_bps_5m),
        atrValue: selected.atr_quote_5m,
        price: parseFloat(selected.last_price),
        tickSize: selected.tick_size,
        minOrderSize: 0.001, // Default, will be updated from exchange info
        stepSize: 0.001, // Default, will be updated from exchange info
        volumeUSDT24h: parseFloat(selected.quote_volume)
      }
      
      console.log(chalk.green(`\n✓ Selected new market: ${this.currentMarket.symbol}`))
      console.log(chalk.gray(`  Price: $${this.currentMarket.price.toFixed(4)}`))
      console.log(chalk.gray(`  ATR: ${this.currentMarket.atrBps.toFixed(0)}bps ($${this.currentMarket.atrValue.toFixed(4)})`))
      console.log(chalk.gray(`  Tick: $${this.currentMarket.tickSize.toFixed(5)}`))
      
      // Initialize orderbook for the new symbol
      await this.initializeOrderbook()
      
      // Update last evaluation time
      this.lastMarketEvaluation = Date.now()
      
    } catch (error) {
      console.error(chalk.red('Failed to re-evaluate markets:'), error)
      // Continue with current market if re-evaluation fails
    }
  }

  private async initializeOrderbook() {
    if (this.websocket) {
      this.websocket.disconnect()
    }
    
    const config: TradingConfig = {
      symbol: this.currentMarket!.symbol,
      tickSize: this.currentMarket!.tickSize,
      minOrderSize: this.currentMarket!.minOrderSize,
      makerFee: 0.0002, // 0.02%
      takerFee: 0.0004, // 0.04%
      atrBps: this.currentMarket!.atrBps,
      targetWinRate: 0.60 // 60% win rate target
    }
    
    this.orderbookDynamics = new OrderbookDynamics(config)
    
    // Create websocket with callback
    this.websocket = new BinanceWebsocket(
      this.currentMarket!.symbol,
      (snapshot: OrderbookSnapshot) => {
        this.orderbookDynamics!.update(snapshot)
      },
      20, // depth levels
      100 // update speed
    )
    
    await this.websocket.connect()
    console.log(chalk.green(`✓ Orderbook websocket connected for ${this.currentMarket!.symbol}`))
  }

  private async huntForEntry() {
    // Double-check we don't have an active position
    if (this.position) {
      console.log(chalk.red('⚠️  Position still active, switching back to POSITION_ACTIVE state'))
      this.state = 'POSITION_ACTIVE'
      return
    }
    
    const now = Date.now()
    if (now - this.lastPatternCheckTime < this.patternCheckInterval) {
      return
    }
    this.lastPatternCheckTime = now
    
    const patterns = this.orderbookDynamics!.getCurrentPatterns()
    const derivatives = this.orderbookDynamics!.getCurrentDerivatives()
    const stats = this.orderbookDynamics!.getStats()
    
    // Check spread condition (must be > 2 ticks for safety)
    const spreadTicks = stats.avgSpread / this.currentMarket!.tickSize
    if (spreadTicks <= 2) {
      return // No sufficient gap to place maker order
    }
    
    // Look for entry patterns
    for (const pattern of patterns) {
      if (this.markerOrder) {
        // Check if we should cancel existing marker order
        if (this.shouldCancelMarkerOrder(pattern)) {
          await this.cancelMarkerOrder()
        }
      } else {
        // Check if we should place new marker order
        const signal = this.checkEntrySignal(pattern)
        if (signal) {
          await this.placeMarkerOrder(signal)
        }
      }
    }
  }

  private checkEntrySignal(pattern: DynamicPattern): { side: 'BUY' | 'SELL', price: number } | null {
    // Get current orderbook
    const orderbook = this.orderbookDynamics!.getCurrentOrderbook()
    if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return null
    }
    
    const bestBid = orderbook.bids[0].price
    const bestAsk = orderbook.asks[0].price
    
    // Long signal: bids LIQUIDITY_SURGE or asks LIQUIDITY_WITHDRAWAL (increased strength requirements)
    if ((pattern.type === 'LIQUIDITY_SURGE' && pattern.side === 'BID' && pattern.strength > 80) ||
        (pattern.type === 'LIQUIDITY_WITHDRAWAL' && pattern.side === 'ASK' && pattern.strength > 85)) {
      // Place buy order just below best ask (one tick inside the spread)
      const price = this.roundToTickSize(bestAsk - this.currentMarket!.tickSize)
      return { side: 'BUY', price }
    }
    
    // Short signal: asks LIQUIDITY_SURGE or bids LIQUIDITY_WITHDRAWAL (increased strength requirements)
    if ((pattern.type === 'LIQUIDITY_SURGE' && pattern.side === 'ASK' && pattern.strength > 80) ||
        (pattern.type === 'LIQUIDITY_WITHDRAWAL' && pattern.side === 'BID' && pattern.strength > 85)) {
      // Place sell order just above best bid (one tick inside the spread)
      const price = this.roundToTickSize(bestBid + this.currentMarket!.tickSize)
      return { side: 'SELL', price }
    }
    
    return null
  }

  private roundToTickSize(price: number): number {
    const tickSize = this.currentMarket!.tickSize
    const precision = this.getPrecisionFromMinSize(tickSize)
    return parseFloat((Math.round(price / tickSize) * tickSize).toFixed(precision))
  }

  private roundToStepSize(quantity: number): number {
    const stepSize = this.currentMarket!.stepSize || 0.001
    const precision = this.getPrecisionFromMinSize(stepSize)
    return parseFloat((Math.floor(quantity / stepSize) * stepSize).toFixed(precision))
  }

  private shouldCancelMarkerOrder(pattern: DynamicPattern): boolean {
    if (!this.markerOrder) return false
    
    // Cancel on MARKET_MAKER_SHIFT
    if (pattern.type === 'MARKET_MAKER_SHIFT') {
      return true
    }
    
    // Cancel long marker if opposite signal
    if (this.markerOrder.side === 'BUY' &&
        ((pattern.type === 'LIQUIDITY_SURGE' && pattern.side === 'ASK') ||
         (pattern.type === 'LIQUIDITY_WITHDRAWAL' && pattern.side === 'BID'))) {
      return true
    }
    
    // Cancel short marker if opposite signal
    if (this.markerOrder.side === 'SELL' &&
        ((pattern.type === 'LIQUIDITY_SURGE' && pattern.side === 'BID') ||
         (pattern.type === 'LIQUIDITY_WITHDRAWAL' && pattern.side === 'ASK'))) {
      return true
    }
    
    return false
  }

  private async placeMarkerOrder(signal: { side: 'BUY' | 'SELL', price: number }) {
    const operationKey = `marker_order_${this.currentMarket!.symbol}`
    
    // Check exponential backoff
    if (!this.backoff.canAttempt(operationKey)) {
      return // Still in cooldown
    }
    
    const positionSize = this.calculatePositionSize()
    
    // Skip if position size is 0 (insufficient balance)
    if (positionSize === 0) {
      return
    }
    
    // Validate order price is reasonable (within 10% of current price)
    const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
    if (orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const midPrice = (orderbook.bids[0].price + orderbook.asks[0].price) / 2
      const priceRatio = signal.price / midPrice
      
      if (priceRatio < 0.9 || priceRatio > 1.1) {
        console.log(chalk.yellow(`⚠️  Skipping order - price ${signal.price.toFixed(4)} is too far from market ${midPrice.toFixed(4)}`))
        return
      }
    }
    
    try {
      const result = await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.currentMarket!.symbol,
          side: signal.side,
          type: 'LIMIT',
          quantity: positionSize,
          price: signal.price,
          timeInForce: 'GTX' // Post-only
        }
      })
      
      const responseText = (result.content as any)[0].text
      
      // Check if it's an error response
      if (responseText.includes('error')) {
        const errorData = JSON.parse(responseText)
        
        // Ignore Post-Only rejection errors when order would execute as taker
        if (errorData.error && errorData.error.includes('could not be executed as maker')) {
          // Silently skip - this is expected when order would cross spread
          return
        }
        
        console.error(chalk.red('Order placement failed:'), errorData.error)
        throw new Error(errorData.error || 'Order placement failed')
      }
      
      const order = JSON.parse(responseText)
      
      // Debug log to check order structure
      if (!order.orderId) {
        console.error(chalk.red('Error: Order response missing orderId'), order)
        throw new Error('Invalid order response')
      }
      
      this.markerOrder = {
        orderId: order.orderId.toString(), // Ensure it's a string
        symbol: order.symbol,
        side: order.side,
        price: parseFloat(order.price),
        size: parseFloat(order.origQty),
        timeInForce: 'GTX'
      }
      
      console.log(chalk.green(`✓ Placed ${signal.side} marker order #${order.orderId} at ${signal.price}`))
      
      // Start monitoring for fill
      this.monitorOrderFill()
      this.backoff.recordSuccess(operationKey) // Reset on success
    } catch (error: any) {
      // Only log if it's not a Post-Only rejection
      if (!error.message || !error.message.includes('could not be executed as maker')) {
        console.error(chalk.red('Failed to place marker order:'), error)
        const nextRetrySeconds = this.backoff.recordFailure(operationKey)
        console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`))
      }
    }
  }
  
  private async monitorOrderFill() {
    if (!this.markerOrder) return
    
    // Clear any existing monitor
    if (this.orderMonitorInterval) {
      clearInterval(this.orderMonitorInterval)
    }
    
    this.orderMonitorInterval = setInterval(async () => {
      try {
        const result = await this.mcpClient!.callTool({
          name: 'get_order',
          arguments: {
            symbol: this.markerOrder!.symbol,
            orderId: this.markerOrder!.orderId
          }
        })
        
        const order = JSON.parse((result.content as any)[0].text)
        
        if (order.status === 'FILLED') {
          clearInterval(this.orderMonitorInterval!)
          this.orderMonitorInterval = null
          await this.onOrderFilled()
        } else if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
          clearInterval(this.orderMonitorInterval!)
          this.orderMonitorInterval = null
          console.log(chalk.yellow(`Marker order #${this.markerOrder!.orderId} ${order.status.toLowerCase()}`))
          this.markerOrder = null
        }
      } catch (error) {
        // Continue monitoring
      }
    }, 1000) // Check every second
  }

  private async cancelMarkerOrder() {
    if (!this.markerOrder) {
      console.warn(chalk.yellow('Warning: Attempted to cancel non-existent marker order'))
      return
    }
    
    const orderId = this.markerOrder.orderId
    const symbol = this.markerOrder.symbol
    const operationKey = `cancel_marker_${symbol}_${orderId}`
    
    // Check exponential backoff
    if (!this.backoff.canAttempt(operationKey)) {
      return // Still in cooldown
    }
    
    try {
      const result = await this.mcpClient!.callTool({
        name: 'cancel_order',
        arguments: {
          symbol: symbol,
          orderId: orderId
        }
      })
      
      console.log(chalk.yellow(`✓ Cancelled marker order #${orderId}`))
      this.markerOrder = null
      
      // Clear order monitor if running
      if (this.orderMonitorInterval) {
        clearInterval(this.orderMonitorInterval)
        this.orderMonitorInterval = null
      }
      this.backoff.recordSuccess(operationKey) // Reset on success
    } catch (error: any) {
      console.error(chalk.red(`Failed to cancel marker order #${orderId}:`), error.message || error)
      // Still clear the marker order reference on error
      this.markerOrder = null
      const nextRetrySeconds = this.backoff.recordFailure(operationKey)
      console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`))
    }
  }

  private async onOrderFilled() {
    if (!this.markerOrder) return
    
    // Double-check we don't already have a position (race condition prevention)
    if (this.position) {
      console.log(chalk.yellow('⚠️  Already have active position, ignoring fill'))
      this.markerOrder = null
      return
    }
    
    const side = this.markerOrder.side === 'BUY' ? 'LONG' : 'SHORT'
    const atrValue = this.currentMarket!.atrValue
    
    // Get current orderbook for TP calculation
    const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
    let tpPrice: number
    
    if (orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const bestBid = orderbook.bids[0].price
      const bestAsk = orderbook.asks[0].price
      const tickSize = this.currentMarket!.tickSize
      
      if (side === 'LONG') {
        // For LONG: We want to sell at the highest price that won't cross the spread
        // Start with ATR-based target
        const atrBasedTP = this.markerOrder.price + (atrValue * 0.5)
        
        // Ensure we're not crossing the spread - must be >= best_ask to be a maker order
        if (atrBasedTP < bestAsk) {
          // If ATR target is below best ask, place at best ask (join the queue)
          tpPrice = this.roundToTickSize(bestAsk)
        } else {
          // If ATR target is above best ask, use it (will be in the book as maker)
          tpPrice = this.roundToTickSize(atrBasedTP)
        }
        
        // Also ensure minimum profit of at least 2 ticks
        const minTP = this.markerOrder.price + (tickSize * 2)
        tpPrice = Math.max(tpPrice, minTP)
        
      } else {
        // For SHORT: We want to buy at the lowest price that won't cross the spread
        // Start with ATR-based target
        const atrBasedTP = this.markerOrder.price - (atrValue * 0.5)
        
        // Ensure we're not crossing the spread - must be <= best_bid to be a maker order
        if (atrBasedTP > bestBid) {
          // If ATR target is above best bid, place at best bid (join the queue)
          tpPrice = this.roundToTickSize(bestBid)
        } else {
          // If ATR target is below best bid, use it (will be in the book as maker)
          tpPrice = this.roundToTickSize(atrBasedTP)
        }
        
        // Also ensure minimum profit of at least 2 ticks
        const minTP = this.markerOrder.price - (tickSize * 2)
        tpPrice = Math.min(tpPrice, minTP)
      }
    } else {
      // Fallback to ATR-based TP if no orderbook data
      tpPrice = this.roundToTickSize(
        side === 'LONG' 
          ? this.markerOrder.price + (atrValue * 0.5)
          : this.markerOrder.price - (atrValue * 0.5)
      )
    }
    
    this.position = {
      symbol: this.markerOrder.symbol,
      side,
      entryPrice: this.markerOrder.price,
      size: this.markerOrder.size,
      originalSize: this.markerOrder.size,
      entryTime: Date.now(),
      tpPrice,
      slPrice: this.roundToTickSize(
        side === 'LONG'
          ? this.markerOrder.price - atrValue  // SL at 1 ATR
          : this.markerOrder.price + atrValue
      )
    }
    
    this.markerOrder = null
    this.positionStartTime = Date.now()
    
    console.log(chalk.green(`\n✓ Position opened: ${side} at ${this.position.entryPrice}`))
    
    // Calculate actual TP distance for logging
    const tpDistance = side === 'LONG' 
      ? (this.position.tpPrice - this.position.entryPrice) / this.position.entryPrice * 10000
      : (this.position.entryPrice - this.position.tpPrice) / this.position.entryPrice * 10000
    
    console.log(chalk.gray(`  TP: ${this.position.tpPrice.toFixed(4)} (+${tpDistance.toFixed(0)}bps)`))
    console.log(chalk.gray(`  SL: ${this.position.slPrice.toFixed(4)} (-${this.currentMarket!.atrBps.toFixed(0)}bps)`))
    
    await this.placeTPSLOrders()
    // Exit timers removed - using only TP/SL
    this.state = 'POSITION_ACTIVE'
  }

  private async placeTPSLOrders() {
    if (!this.position) return
    
    try {
      // Place TP order (maker limit order with GTX)
      const tpResult = await this.mcpClient!.callTool({
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
      })
      
      const tpResponseText = (tpResult.content as any)[0].text
      
      // Check for GTX rejection on TP order
      if (tpResponseText.includes('could not be executed as maker')) {
        console.log(chalk.yellow('TP order would cross spread, using GTC instead'))
        // Retry with GTC
        const tpRetryResult = await this.mcpClient!.callTool({
          name: 'place_order',
          arguments: {
            symbol: this.position.symbol,
            side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'LIMIT',
            quantity: this.position.size,
            price: this.position.tpPrice,  // Use original TP price in initial placement
            timeInForce: 'GTC',
            reduceOnly: true
          }
        })
        const tpOrder = JSON.parse((tpRetryResult.content as any)[0].text)
        this.position.tpOrderId = tpOrder.orderId
        console.log(chalk.green(`✓ TP order placed #${tpOrder.orderId} at ${this.position.tpPrice.toFixed(4)} (GTC)`))
      } else {
        const tpOrder = JSON.parse(tpResponseText)
        this.position.tpOrderId = tpOrder.orderId
        console.log(chalk.green(`✓ TP order placed #${tpOrder.orderId} at ${this.position.tpPrice.toFixed(4)} (GTX)`))
      }
      
      // Place SL order (stop market order)
      const slResult = await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          quantity: this.position.size,
          stopPrice: this.position.slPrice,
          reduceOnly: true
        }
      })
      
      const slResponseText = (slResult.content as any)[0].text
      
      // Check if it's an error response
      if (slResponseText.includes('error')) {
        const errorData = JSON.parse(slResponseText)
        console.error(chalk.red('SL order placement failed:'), errorData.error)
      } else {
        const slOrder = JSON.parse(slResponseText)
        if (slOrder.orderId) {
          this.position.slOrderId = slOrder.orderId
          console.log(chalk.green(`✓ SL order placed #${slOrder.orderId} at ${this.position.slPrice.toFixed(4)} (STOP_MARKET)`))
        } else {
          console.error(chalk.red('SL order response missing orderId'), slOrder)
        }
      }
      
    } catch (error) {
      console.error(chalk.red('Failed to place TP/SL orders:'), error)
    }
  }

  private setupExitTimers() {
    // Time-based exits removed for simplicity
    // Strategy now relies only on TP/SL
  }

  // Removed - no longer using time-based exits

  private async managePosition() {
    if (!this.position) {
      this.state = 'ENTRY_HUNTING'
      return
    }
    
    // Periodically verify position still exists (every 10 seconds)
    const now = Date.now()
    if (now - this.lastPositionCheck > 10000) {
      this.lastPositionCheck = now
      
      try {
        const posResult = await this.mcpClient!.callTool({
          name: 'get_positions',
          arguments: {}
        })
        
        const posResponse = JSON.parse((posResult.content as any)[0].text)
        const positions = posResponse.positions || []
        
        const activePosition = positions.find((p: any) => 
          p.symbol === this.position!.symbol && 
          parseFloat(p.positionAmt) !== 0
        )
        
        if (!activePosition) {
          console.log(chalk.yellow('\n⚠️  Position no longer exists - switching to entry hunting'))
          await this.cancelPendingOrders()
          this.position = null
          this.clearExitTimers()
          this.state = 'ENTRY_HUNTING'
          return
        }
      } catch (error) {
        console.error(chalk.red('Failed to verify position:'), error)
      }
    }
    
    // Get current price from orderbook
    const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
    if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return // No valid orderbook data
    }
    
    const currentPrice = (orderbook.bids[0].price + orderbook.asks[0].price) / 2 // Mid price
    const slPrice = this.position.slPrice
    const breachedSL = this.position.side === 'LONG' 
      ? currentPrice <= slPrice 
      : currentPrice >= slPrice
    
    if (breachedSL && !this.position.slOrderId) {
      console.log(chalk.red(`\n⚠️  Price ${currentPrice.toFixed(4)} breached SL ${slPrice.toFixed(4)}`))
      console.log(chalk.red(`🚨 EMERGENCY EXIT - No SL order active`))
      
      try {
        await this.mcpClient!.callTool({
          name: 'close_position',
          arguments: {
            symbol: this.position.symbol,
            percentage: 100
          }
        })
        
        console.log(chalk.red(`✓ Emergency exit completed`))
        this.position = null
        this.clearExitTimers()
        this.state = 'ENTRY_HUNTING'
        return
      } catch (error) {
        console.error(chalk.red('Failed to emergency exit:'), error)
      }
    }
    
    // Check if TP/SL orders are missing and place them
    await this.ensureTPSLOrders()
    
    // Double-check position still exists after async operations
    if (!this.position) {
      this.state = 'ENTRY_HUNTING'
      return
    }
    
    const pnlBps = this.calculatePnlBps()
    const holdTime = (Date.now() - this.position.entryTime) / 1000 / 60 // minutes
    
    // Double-check position still exists
    if (!this.position) {
      this.state = 'ENTRY_HUNTING'
      return
    }
    
    // Removed quick exit rule for simplicity
    // Now only TP/SL will close positions
    
    // Check position status periodically (not too frequently)
    if (now - this.lastPositionCheck >= this.positionCheckInterval) {
      this.lastPositionCheck = now
      await this.checkPositionStatus()
    }
  }
  
  private async ensureTPSLOrders() {
    if (!this.position) return
    
    const now = Date.now()
    
    // Only check TP/SL orders every 5 seconds to avoid spam
    if (now - this.lastTPSLCheck < this.tpslCheckInterval) {
      return
    }
    
    this.lastTPSLCheck = now
    
    try {
      // Log current position state
      const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
      if (orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0) {
        const currentPrice = (orderbook.bids[0].price + orderbook.asks[0].price) / 2
        const distanceToTP = this.position.side === 'LONG' 
          ? ((this.position.tpPrice - currentPrice) / currentPrice * 10000).toFixed(1)
          : ((currentPrice - this.position.tpPrice) / currentPrice * 10000).toFixed(1)
        const distanceToSL = this.position.side === 'LONG'
          ? ((currentPrice - this.position.slPrice) / currentPrice * 10000).toFixed(1)
          : ((this.position.slPrice - currentPrice) / currentPrice * 10000).toFixed(1)
          
        // Only log position status every 10 seconds
        const now = Date.now()
        if (now - this.lastPositionCheck >= 10000) {
          console.log(chalk.gray(`  📍 Current: ${currentPrice.toFixed(4)} | TP: ${distanceToTP}bps away | SL: ${distanceToSL}bps away`))
        }
      }
      
      // Check if we need to place TP order
      if (!this.position.tpOrderId) {
        await this.placeTPOrder()
      } else {
        // Verify TP order still exists
        try {
          const tpCheck = await this.mcpClient!.callTool({
            name: 'get_order',
            arguments: {
              symbol: this.position.symbol,
              orderId: this.position.tpOrderId
            }
          })
          const tpOrder = JSON.parse((tpCheck.content as any)[0].text)
          if (tpOrder.status === 'CANCELED' || tpOrder.status === 'EXPIRED') {
            console.log(chalk.yellow('TP order was cancelled/expired, replacing...'))
            this.position.tpOrderId = undefined
            await this.placeTPOrder()
          }
        } catch (error) {
          // Order might not exist
          console.log(chalk.yellow('TP order not found, placing new one...'))
          this.position.tpOrderId = undefined
          await this.placeTPOrder()
        }
      }
      
      // Check if we need to place SL order
      if (!this.position.slOrderId) {
        await this.placeSLOrder()
      } else {
        // Verify SL order still exists
        try {
          const slCheck = await this.mcpClient!.callTool({
            name: 'get_order',
            arguments: {
              symbol: this.position.symbol,
              orderId: this.position.slOrderId
            }
          })
          const slOrder = JSON.parse((slCheck.content as any)[0].text)
          if (slOrder.status === 'CANCELED' || slOrder.status === 'EXPIRED') {
            console.log(chalk.yellow('SL order was cancelled/expired, replacing...'))
            this.position.slOrderId = undefined
            await this.placeSLOrder()
          }
        } catch (error) {
          // Order might not exist
          console.log(chalk.yellow('SL order not found, placing new one...'))
          this.position.slOrderId = undefined
          await this.placeSLOrder()
        }
      }
    } catch (error) {
      console.error(chalk.red('Error checking TP/SL orders:'), error)
    }
  }
  
  private async placeTPOrder() {
    if (!this.position) return
    
    // First check if we actually need a new TP order
    if (this.position.tpOrderId) {
      try {
        const orderCheck = await this.mcpClient!.callTool({
          name: 'get_order',
          arguments: {
            symbol: this.position.symbol,
            orderId: this.position.tpOrderId
          }
        })
        const order = JSON.parse((orderCheck.content as any)[0].text)
        
        // If order exists and is active, check if price matches
        if (order && (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED')) {
          const orderPrice = parseFloat(order.price)
          const priceDiff = Math.abs(orderPrice - this.position.tpPrice)
          
          // If price is close enough (within 0.1%), keep the existing order
          if (priceDiff / this.position.tpPrice < 0.001) {
            return // Order is fine, no need to replace
          } else {
            console.log(chalk.yellow(`TP order price mismatch: ${orderPrice} vs ${this.position.tpPrice}, replacing...`))
          }
        }
      } catch (error) {
        // Order might not exist, continue to place new one
      }
    }
    
    const operationKey = `tp_order_${this.position.symbol}`
    
    // Check exponential backoff
    if (!this.backoff.canAttempt(operationKey)) {
      return // Still in cooldown
    }
    
    console.log(chalk.yellow('TP order missing, placing now...'))
    
    // Recalculate TP price based on current orderbook to avoid crossing spread
    const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
    let currentTPPrice = this.position.tpPrice
    
    if (orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const bestBid = orderbook.bids[0].price
      const bestAsk = orderbook.asks[0].price
      const tickSize = this.currentMarket!.tickSize
      const atrValue = this.currentMarket!.atrValue
      
      console.log(chalk.gray(`  Current orderbook: Bid: ${bestBid} | Ask: ${bestAsk}`))
      console.log(chalk.gray(`  Original TP price: ${this.position.tpPrice} | Side: ${this.position.side}`))
      
      // Recalculate TP to ensure it won't cross spread
      if (this.position.side === 'LONG') {
        // For LONG: We want to sell, so TP must be >= best_ask to be a maker order
        const atrBasedTP = this.position.entryPrice + (atrValue * 0.5)
        
        if (atrBasedTP < bestAsk) {
          // If ATR target is below best ask, place at best ask
          currentTPPrice = this.roundToTickSize(bestAsk)
        } else {
          // Use ATR target
          currentTPPrice = this.roundToTickSize(atrBasedTP)
        }
        
        // Ensure minimum profit of 2 ticks
        const minTP = this.position.entryPrice + (tickSize * 2)
        currentTPPrice = Math.max(currentTPPrice, minTP)
        
        console.log(chalk.gray(`  LONG TP recalculated: ${currentTPPrice} (must be >= ${bestAsk} to avoid crossing)`))
      } else {
        // For SHORT: We want to buy, so TP must be <= best_bid to be a maker order
        const atrBasedTP = this.position.entryPrice - (atrValue * 0.5)
        
        if (atrBasedTP > bestBid) {
          // If ATR target is above best bid, place at best bid
          currentTPPrice = this.roundToTickSize(bestBid)
        } else {
          // Use ATR target
          currentTPPrice = this.roundToTickSize(atrBasedTP)
        }
        
        // Ensure minimum profit of 2 ticks
        const minTP = this.position.entryPrice - (tickSize * 2)
        currentTPPrice = Math.min(currentTPPrice, minTP)
        
        console.log(chalk.gray(`  SHORT TP recalculated: ${currentTPPrice} (must be <= ${bestBid} to avoid crossing)`))
      }
    }
    
    try {
      // Place TP order (maker limit order with GTX)
      const tpResult = await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'LIMIT',
          quantity: this.position.size,
          price: currentTPPrice,  // Use recalculated price
          timeInForce: 'GTX', // Post-only for maker fees
          reduceOnly: true
        }
      })
      
      const tpResponseText = (tpResult.content as any)[0].text
      
      // Check for error response
      if (tpResponseText.includes('error')) {
        const errorData = JSON.parse(tpResponseText)
        
        // Special handling for ReduceOnly rejection - might mean position closed
        if (errorData.error && errorData.error.includes('ReduceOnly Order is rejected')) {
          console.log(chalk.yellow('⚠️  ReduceOnly order rejected - checking if position closed...'))
          console.log(chalk.gray(`  Raw error: ${JSON.stringify(errorData)}`))  // Log raw error for debugging
          
          // Check current positions
          try {
            const posResult = await this.mcpClient!.callTool({
              name: 'get_positions',
              arguments: {}
            })
            
            const posResponse = JSON.parse((posResult.content as any)[0].text)
            const positions = posResponse.positions || []
            
            const activePosition = positions.find((p: any) => 
              p.symbol === this.position!.symbol && 
              parseFloat(p.positionAmt) !== 0
            )
            
            if (!activePosition) {
              console.log(chalk.green('✓ Position confirmed closed'))
              await this.switchToEntryHunting()
            }
          } catch (error) {
            console.error(chalk.red('Failed to check position status:'), error)
          }
          
          return
        }
        
        console.error(chalk.red('Failed to place TP order:'), errorData.error)
        const nextRetrySeconds = this.backoff.recordFailure(operationKey)
        console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`))
        return
      }
      
      // Check for GTX rejection on TP order
      if (tpResponseText.includes('could not be executed as maker')) {
        // Retry with GTC
        const tpRetryResult = await this.mcpClient!.callTool({
          name: 'place_order',
          arguments: {
            symbol: this.position.symbol,
            side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'LIMIT',
            quantity: this.position.size,
            price: currentTPPrice,  // Use recalculated price
            timeInForce: 'GTC',
            reduceOnly: true
          }
        })
        const tpRetryResponseText = (tpRetryResult.content as any)[0].text
        if (tpRetryResponseText.includes('error')) {
          const errorData = JSON.parse(tpRetryResponseText)
          console.error(chalk.red('Failed to place TP order (GTC):'), errorData.error)
          const nextRetrySeconds = this.backoff.recordFailure(operationKey)
          console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`))
          return
        }
        const tpOrder = JSON.parse(tpRetryResponseText)
        if (!tpOrder.orderId) {
          console.error(chalk.red('TP order response missing orderId'), tpOrder)
          const nextRetrySeconds = this.backoff.recordFailure(operationKey)
          console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`))
          return
        }
        this.position.tpOrderId = tpOrder.orderId.toString()
        this.position.tpPrice = currentTPPrice  // Update stored TP price
        console.log(chalk.green(`✓ TP order placed #${tpOrder.orderId} at ${currentTPPrice.toFixed(4)} (GTC)`))
        this.backoff.recordSuccess(operationKey) // Reset on success
        this.lastOrderPlacement = Date.now() // Record order placement time
      } else {
        const tpOrder = JSON.parse(tpResponseText)
        if (!tpOrder.orderId) {
          console.error(chalk.red('TP order response missing orderId'), tpOrder)
          const nextRetrySeconds = this.backoff.recordFailure(operationKey)
          console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`))
          return
        }
        this.position.tpOrderId = tpOrder.orderId.toString()
        this.position.tpPrice = currentTPPrice  // Update stored TP price
        console.log(chalk.green(`✓ TP order placed #${tpOrder.orderId} at ${currentTPPrice.toFixed(4)} (GTX)`))
        this.backoff.recordSuccess(operationKey) // Reset on success
        this.lastOrderPlacement = Date.now() // Record order placement time
      }
    } catch (error) {
      console.error(chalk.red('Failed to place TP order:'), error)
      const nextRetrySeconds = this.backoff.recordFailure(operationKey)
      console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`))
    }
  }
  
  private async placeSLOrder() {
    if (!this.position) return
    
    // First check if we actually need a new SL order
    if (this.position.slOrderId) {
      try {
        const orderCheck = await this.mcpClient!.callTool({
          name: 'get_order',
          arguments: {
            symbol: this.position.symbol,
            orderId: this.position.slOrderId
          }
        })
        const order = JSON.parse((orderCheck.content as any)[0].text)
        
        // If order exists and is active, check if price matches
        if (order && (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED')) {
          const orderStopPrice = parseFloat(order.stopPrice)
          const priceDiff = Math.abs(orderStopPrice - this.position.slPrice)
          
          // If price is close enough (within 0.1%), keep the existing order
          if (priceDiff / this.position.slPrice < 0.001) {
            return // Order is fine, no need to replace
          } else {
            console.log(chalk.yellow(`SL order price mismatch: ${orderStopPrice} vs ${this.position.slPrice}, replacing...`))
          }
        }
      } catch (error) {
        // Order might not exist, continue to place new one
      }
    }
    
    const operationKey = `sl_order_${this.position.symbol}`
    
    // Check exponential backoff
    if (!this.backoff.canAttempt(operationKey)) {
      return // Still in cooldown
    }
    
    console.log(chalk.yellow('SL order missing, placing now...'))
    
    // Check current price vs SL level
    const currentPrice = this.currentMarket!.price
    const slPrice = this.position.slPrice
    
    // Check if we've already breached the SL level
    const breachedSL = this.position.side === 'LONG' 
      ? currentPrice <= slPrice 
      : currentPrice >= slPrice
    
    if (breachedSL) {
      // Price has already moved beyond SL - close immediately at market
      console.log(chalk.red(`⚠️  Price ${currentPrice.toFixed(4)} already beyond SL ${slPrice.toFixed(4)}`))
      console.log(chalk.red(`🚨 EMERGENCY EXIT - Closing position at market price`))
      
      try {
        await this.mcpClient!.callTool({
          name: 'close_position',
          arguments: {
            symbol: this.position.symbol,
            percentage: 100
          }
        })
        
        console.log(chalk.red(`✓ Emergency exit completed at market price`))
        
        // Clear position and exit timers
        this.position = null
        this.clearExitTimers()
        this.state = 'ENTRY_HUNTING'
      } catch (error) {
        console.error(chalk.red('Failed to emergency exit position:'), error)
      }
      
      return
    }
    
    try {
      // Place SL order (stop market order)
      const slResult = await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          quantity: this.position.size,
          stopPrice: this.position.slPrice,
          reduceOnly: true
        }
      })
      
      const slResponseText = (slResult.content as any)[0].text
      
      // Check if it's an error response
      if (slResponseText.includes('error')) {
        const errorData = JSON.parse(slResponseText)
        
        // Check if error is "would immediately trigger"
        if (errorData.error && errorData.error.includes('would immediately trigger')) {
          console.log(chalk.red(`⚠️  SL order would immediately trigger at ${slPrice.toFixed(4)}`))
          console.log(chalk.red(`🚨 EMERGENCY EXIT - Closing position at market price`))
          
          // Close at market immediately
          await this.mcpClient!.callTool({
            name: 'close_position',
            arguments: {
              symbol: this.position.symbol,
              percentage: 100
            }
          })
          
          console.log(chalk.red(`✓ Emergency exit completed at market price`))
          
          // Clear position and exit timers
          this.position = null
          this.clearExitTimers()
          this.state = 'ENTRY_HUNTING'
          return
        }
        
        // Special handling for ReduceOnly rejection - might mean position closed
        if (errorData.error && errorData.error.includes('ReduceOnly Order is rejected')) {
          console.log(chalk.yellow('⚠️  ReduceOnly SL order rejected - checking if position closed...'))
          
          // Check current positions
          try {
            const posResult = await this.mcpClient!.callTool({
              name: 'get_positions',
              arguments: {}
            })
            
            const posResponse = JSON.parse((posResult.content as any)[0].text)
            const positions = posResponse.positions || []
            
            const activePosition = positions.find((p: any) => 
              p.symbol === this.position!.symbol && 
              parseFloat(p.positionAmt) !== 0
            )
            
            if (!activePosition) {
              console.log(chalk.green('✓ Position confirmed closed'))
              await this.switchToEntryHunting()
            }
          } catch (error) {
            console.error(chalk.red('Failed to check position status:'), error)
          }
          
          return
        }
        
        console.error(chalk.red('SL order placement failed:'), errorData.error)
        
        // Don't mark as having an order ID if it failed
        this.position.slOrderId = undefined
        return
      }
      
      const slOrder = JSON.parse(slResponseText)
      
      // Verify we have an order ID
      if (!slOrder.orderId) {
        console.error(chalk.red('SL order response missing orderId'), slOrder)
        this.position.slOrderId = undefined
        return
      }
      
      this.position.slOrderId = slOrder.orderId
      console.log(chalk.green(`✓ SL order placed #${slOrder.orderId} at ${this.position.slPrice.toFixed(4)} (STOP_MARKET)`))
      this.backoff.recordSuccess(operationKey) // Reset on success
      this.lastOrderPlacement = Date.now() // Record order placement time
    } catch (error) {
      console.error(chalk.red('Failed to place SL order:'), error)
      this.position!.slOrderId = undefined
      const nextRetrySeconds = this.backoff.recordFailure(operationKey)
      console.log(chalk.gray(`  Will retry in ${nextRetrySeconds}s...`))
    }
  }
  
  private async checkPositionStatus() {
    // Skip REST API checks - we now use WebSocket for real-time position updates
    return
    
    // DEPRECATED: Old REST API implementation
    /*
    try {
      const result = await this.mcpClient!.callTool({
        name: 'get_positions',
        arguments: {}
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      const positions = response.positions || []
      const currentPosition = positions.find((p: any) => p.symbol === this.position?.symbol)
      
      if (!currentPosition || currentPosition.positionAmt === 0) {
        // Double-check this is a real closure, not an API glitch
        const pnl = this.position ? this.calculatePnlBps() : 0
        const holdTime = this.position ? (Date.now() - this.position.entryTime) / 1000 : 0 // seconds
        
        // If position is very new (< 5 seconds), likely an API glitch
        if (this.position && holdTime < 5) {
          console.log(chalk.yellow(`⚠️  API returned no position but position is only ${holdTime.toFixed(1)}s old - likely an error, keeping position`))
          return
        }
        
        // If we have negative PnL and neither TP nor SL was hit, this might be an error
        if (this.position && pnl < 0) {
          // Get current price from orderbook
          const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
          const currentPrice = orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0 
            ? (orderbook.bids[0].price + orderbook.asks[0].price) / 2 
            : 0
            
          if (currentPrice > 0) {
            // Check if price is between TP and SL (position should still be open)
            const priceWithinRange = this.position.side === 'LONG'
              ? currentPrice > this.position.slPrice && currentPrice < this.position.tpPrice
              : currentPrice < this.position.slPrice && currentPrice > this.position.tpPrice
              
            if (priceWithinRange) {
              console.log(chalk.yellow(`⚠️  API returned no position but price ${currentPrice.toFixed(4)} is within TP/SL range - likely an error, keeping position`))
              return // Don't close the position
            }
          }
        }
        
        // Position genuinely closed
        // Get current price from orderbook
        const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
        const closedPrice = orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0 
          ? (orderbook.bids[0].price + orderbook.asks[0].price) / 2 
          : this.currentMarket?.price || 0
        
        console.log(chalk.green(`\n✓ Position closed at ${closedPrice.toFixed(4)} (PnL: ${pnl.toFixed(1)}bps)`))
        
        // Log why it might have closed
        if (this.position) {
          console.log(chalk.gray(`  Entry: ${this.position.entryPrice.toFixed(4)}`))
          console.log(chalk.gray(`  TP: ${this.position.tpPrice.toFixed(4)}`))
          console.log(chalk.gray(`  SL: ${this.position.slPrice.toFixed(4)}`))
          
          // Check if TP or SL was hit
          if (this.position.side === 'LONG') {
            if (closedPrice >= this.position.tpPrice) {
              console.log(chalk.green(`  ✓ Take Profit hit!`))
            } else if (closedPrice <= this.position.slPrice) {
              console.log(chalk.red(`  ✗ Stop Loss hit!`))
            } else if (pnl < 0) {
              console.log(chalk.yellow(`  ⚠️  Closed with loss but neither TP nor SL hit - manual close or liquidation?`))
            }
          } else {
            if (closedPrice <= this.position.tpPrice) {
              console.log(chalk.green(`  ✓ Take Profit hit!`))
            } else if (closedPrice >= this.position.slPrice) {
              console.log(chalk.red(`  ✗ Stop Loss hit!`))
            } else if (pnl < 0) {
              console.log(chalk.yellow(`  ⚠️  Closed with loss but neither TP nor SL hit - manual close or liquidation?`))
            }
          }
        }
        
        // Cancel any pending orders before clearing position
        await this.cancelPendingOrders()
        
        this.position = null
        this.clearExitTimers()
        this.state = 'ENTRY_HUNTING'
        
        // Add cooldown after position closure to prevent immediate re-entry
        this.lastPatternCheckTime = Date.now() + 5000 // 5 second cooldown
      }
    } catch (error) {
      // Ignore errors in position checking
    }
    */
  }

  private calculatePnlBps(): number {
    if (!this.position) return 0
    
    // Get current price from orderbook
    const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
    if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return 0
    }
    
    const currentPrice = (orderbook.bids[0].price + orderbook.asks[0].price) / 2 // Mid price
    const pnlPercent = this.position.side === 'LONG'
      ? (currentPrice - this.position.entryPrice) / this.position.entryPrice
      : (this.position.entryPrice - currentPrice) / this.position.entryPrice
    
    return pnlPercent * 10000 // Convert to basis points
  }


  private async exitPosition(percent: number) {
    if (!this.position) return
    
    // Calculate exit size with proper precision
    const rawExitSize = this.position.size * percent
    const minSize = this.currentMarket!.minOrderSize
    const precision = this.getPrecisionFromMinSize(minSize)
    const exitSize = parseFloat(rawExitSize.toFixed(precision))
    
    // Ensure we exit at least minimum order size
    if (exitSize < minSize) return
    
    try {
      await this.mcpClient!.callTool({
        name: 'close_position',
        arguments: {
          symbol: this.position.symbol,
          percentage: percent * 100 // Convert to percentage
        }
      })
      
      console.log(chalk.green(`✓ Exited ${exitSize} contracts at market`))
      
      this.position.size -= exitSize
      if (this.position.size === 0 || percent >= 1.0) {
        // Cancel all pending orders before clearing position
        await this.cancelPendingOrders()
        
        this.position = null
        this.clearExitTimers()
        this.state = 'ENTRY_HUNTING'
        
        // Add cooldown after position exit
        this.lastPatternCheckTime = Date.now() + 5000 // 5 second cooldown
      }
    } catch (error) {
      console.error(chalk.red('Failed to exit position:'), error)
    }
  }

  private calculatePositionSize(): number {
    // Check if balance is too low
    if (this.accountBalance < 5) {
      console.log(chalk.red(`❌ Insufficient balance: $${this.accountBalance.toFixed(2)} (min $5 required)`))
      return 0
    }
    
    // Get current price from orderbook
    const orderbook = this.orderbookDynamics?.getCurrentOrderbook()
    if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return this.currentMarket!.minOrderSize
    }
    
    const currentPrice = (orderbook.bids[0].price + orderbook.asks[0].price) / 2
    
    // 30% risk rule
    const riskAmount = this.accountBalance * 0.30
    const atrValue = this.currentMarket!.atrValue
    const slDistance = atrValue // SL is 1 ATR away
    
    // Position size = Risk Amount / SL Distance
    let positionSize = riskAmount / slDistance
    
    // Apply max position limit (optional safety)
    const maxSize = this.accountBalance / currentPrice * 2 // Max 2x leverage
    positionSize = Math.min(positionSize, maxSize)
    
    // Ensure minimum notional value ($5)
    const minNotional = 5.0
    const minSizeForNotional = minNotional / currentPrice
    
    // Round to min order size precision
    const minSize = Math.max(this.currentMarket!.minOrderSize, minSizeForNotional)
    positionSize = Math.max(positionSize, minSize)
    
    // Round to step size
    positionSize = this.roundToStepSize(positionSize)
    
    // Log position size calculation
    console.log(chalk.gray(`  Position size: ${positionSize} (notional: $${(positionSize * currentPrice).toFixed(2)})`))
    
    return positionSize
  }

  private getPrecisionFromMinSize(minSize: number): number {
    // Convert minSize to string and count decimals
    const str = minSize.toString()
    const parts = str.split('.')
    return parts.length > 1 ? parts[1].length : 0
  }

  private clearExitTimers() {
    // No longer needed - time-based exits removed
  }
  
  private async syncPositionState() {
    // Periodic sync to ensure position state matches actual account state
    try {
      const result = await this.mcpClient!.callTool({
        name: 'get_positions',
        arguments: {}
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      const positions = response.positions || []
      const hasActivePosition = positions.some((p: any) => 
        p.symbol === this.currentMarket?.symbol && p.positionAmt !== 0
      )
      
      // Fix state mismatches
      if (hasActivePosition && !this.position && this.state === 'ENTRY_HUNTING') {
        const activePos = positions.find((p: any) => 
          p.symbol === this.currentMarket?.symbol && p.positionAmt !== 0
        )
        console.log(chalk.yellow(`⚠️  Found active position but bot thinks none exists`))
        console.log(chalk.gray(`  Symbol: ${activePos.symbol}`))
        console.log(chalk.gray(`  Side: ${parseFloat(activePos.positionAmt) > 0 ? 'LONG' : 'SHORT'}`))
        console.log(chalk.gray(`  Size: ${Math.abs(parseFloat(activePos.positionAmt))}`))
        console.log(chalk.gray(`  Entry: ${activePos.entryPrice}`))
        this.state = 'SEARCHING_MARKET' // Reset to search for a new market
        this.markerOrder = null
      } else if (!hasActivePosition && this.position) {
        console.log(chalk.yellow('⚠️  No active position found but bot thinks one exists - clearing position'))
        await this.cancelPendingOrders()
        this.position = null
        this.clearExitTimers()
        this.state = 'ENTRY_HUNTING'
      }
    } catch (error) {
      // Ignore sync errors
    }
  }
  
  private async cancelPendingOrders() {
    try {
      // Cancel marker order if exists
      if (this.markerOrder) {
        await this.cancelMarkerOrder()
      }
      
      // Cancel TP/SL orders if they exist
      if (this.position) {
        const promises = []
        
        if (this.position.tpOrderId) {
          promises.push(
            this.mcpClient!.callTool({
              name: 'cancel_order',
              arguments: {
                symbol: this.position.symbol,
                orderId: this.position.tpOrderId
              }
            }).catch(() => {}) // Ignore errors
          )
        }
        
        if (this.position.slOrderId) {
          promises.push(
            this.mcpClient!.callTool({
              name: 'cancel_order',
              arguments: {
                symbol: this.position.symbol,
                orderId: this.position.slOrderId
              }
            }).catch(() => {}) // Ignore errors
          )
        }
        
        await Promise.all(promises)
      }
    } catch (error) {
      // Ignore errors in order cancellation
    }
  }

  private startPeriodicCleanup() {
    // Run cleanup every 30 seconds
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupDanglingOrders()
    }, 30000)
    
    // Run initial cleanup after 5 seconds
    setTimeout(() => this.cleanupDanglingOrders(), 5000)
  }
  
  private async cleanupDanglingOrders() {
    try {
      // Different cleanup logic based on state
      if (this.state === 'POSITION_ACTIVE' && this.position) {
        // When we have a position, cleanup any orders that aren't our TP/SL
        await this.cleanupPositionOrders()
      } else if (this.state === 'ENTRY_HUNTING') {
        // When hunting for entry, cleanup orders from other symbols
        await this.cleanupEntryHuntingOrders()
      }
    } catch (error) {
      // Silently ignore cleanup errors
    }
  }
  
  private async cleanupPositionOrders() {
    try {
      if (!this.position || !this.currentMarket) return
      
      // Skip cleanup if we have both TP and SL orders tracked
      if (this.position.tpOrderId && this.position.slOrderId) {
        // Verify they still exist
        try {
          const tpCheck = await this.mcpClient!.callTool({
            name: 'get_order',
            arguments: {
              symbol: this.position.symbol,
              orderId: this.position.tpOrderId
            }
          })
          const tpOrder = JSON.parse((tpCheck.content as any)[0].text)
          
          const slCheck = await this.mcpClient!.callTool({
            name: 'get_order',
            arguments: {
              symbol: this.position.symbol,
              orderId: this.position.slOrderId
            }
          })
          const slOrder = JSON.parse((slCheck.content as any)[0].text)
          
          // If both orders exist and are active, no cleanup needed
          if (tpOrder && (tpOrder.status === 'NEW' || tpOrder.status === 'PARTIALLY_FILLED') &&
              slOrder && (slOrder.status === 'NEW' || slOrder.status === 'PARTIALLY_FILLED')) {
            return
          }
        } catch (error) {
          // One or both orders might not exist, continue with cleanup
        }
      }
      
      // Get all open orders
      const result = await this.mcpClient!.callTool({
        name: 'get_open_orders',
        arguments: { symbol: this.currentMarket.symbol }
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      const openOrders = response.orders || []
      
      if (openOrders.length === 0) return
      
      // Group orders by type
      const tpOrders: any[] = []
      const slOrders: any[] = []
      const otherOrders: any[] = []
      
      for (const order of openOrders) {
        
        // Check both reduceOnly and closePosition fields (Binance may use either)
        const isReduceOnly = order.reduceOnly || order.closePosition
        
        if (!isReduceOnly) {
          // Non reduce-only orders are definitely not TP/SL
          otherOrders.push(order)
        } else if (order.type === 'LIMIT') {
          // TP orders are reduce-only limit orders
          // For LONG: TP is SELL, for SHORT: TP is BUY
          const isTPSide = (this.position.side === 'LONG' && order.side === 'SELL') || 
                          (this.position.side === 'SHORT' && order.side === 'BUY')
          if (isTPSide) {
            tpOrders.push(order)
          } else {
            otherOrders.push(order)
          }
        } else if (order.type === 'STOP_MARKET' || order.type === 'STOP') {
          // SL orders are stop market orders
          // For proper SL: LONG position has SELL stop, SHORT position has BUY stop
          const isSLSide = (this.position.side === 'LONG' && order.side === 'SELL') || 
                          (this.position.side === 'SHORT' && order.side === 'BUY')
          if (isSLSide) {
            slOrders.push(order)
          } else {
            otherOrders.push(order)
          }
        } else {
          otherOrders.push(order)
        }
      }
      
      // Cancel all non-TP/SL orders
      for (const order of otherOrders) {
        console.log(chalk.yellow(`  ⚠️  Cancelling non-TP/SL order: ${order.side} ${order.type} #${order.orderId}`))
        await this.mcpClient!.callTool({
          name: 'cancel_order',
          arguments: {
            symbol: order.symbol,
            orderId: order.orderId
          }
        }).catch(() => {})
      }
      
      // Handle TP orders
      if (tpOrders.length > 1) {
        console.log(chalk.yellow(`  ⚠️  Found ${tpOrders.length} TP orders, keeping best one`))
        
        // Keep the one closest to our desired TP price
        let bestTP = tpOrders[0]
        let bestDiff = Math.abs(parseFloat(bestTP.price) - this.position.tpPrice)
        
        for (const order of tpOrders) {
          const diff = Math.abs(parseFloat(order.price) - this.position.tpPrice)
          if (diff < bestDiff) {
            bestTP = order
            bestDiff = diff
          }
        }
        
        // Update our tracked TP order ID
        this.position.tpOrderId = bestTP.orderId.toString()
        
        // Cancel the rest
        for (const order of tpOrders) {
          if (order.orderId !== bestTP.orderId) {
            console.log(chalk.yellow(`  ⚠️  Cancelling duplicate TP order #${order.orderId}`))
            await this.mcpClient!.callTool({
              name: 'cancel_order',
              arguments: {
                symbol: order.symbol,
                orderId: order.orderId
              }
            }).catch(() => {})
          }
        }
      } else if (tpOrders.length === 1) {
        // Update our tracked TP order ID to match the actual order
        this.position.tpOrderId = tpOrders[0].orderId.toString()
      }
      
      // Handle SL orders
      if (slOrders.length > 1) {
        console.log(chalk.yellow(`  ⚠️  Found ${slOrders.length} SL orders, keeping best one`))
        
        // Keep the one closest to our desired SL price
        let bestSL = slOrders[0]
        let bestDiff = Math.abs(parseFloat(bestSL.stopPrice) - this.position.slPrice)
        
        for (const order of slOrders) {
          const diff = Math.abs(parseFloat(order.stopPrice) - this.position.slPrice)
          if (diff < bestDiff) {
            bestSL = order
            bestDiff = diff
          }
        }
        
        // Update our tracked SL order ID
        this.position.slOrderId = bestSL.orderId.toString()
        
        // Cancel the rest
        for (const order of slOrders) {
          if (order.orderId !== bestSL.orderId) {
            console.log(chalk.yellow(`  ⚠️  Cancelling duplicate SL order #${order.orderId}`))
            await this.mcpClient!.callTool({
              name: 'cancel_order',
              arguments: {
                symbol: order.symbol,
                orderId: order.orderId
              }
            }).catch(() => {})
          }
        }
      } else if (slOrders.length === 1) {
        // Update our tracked SL order ID to match the actual order
        this.position.slOrderId = slOrders[0].orderId.toString()
      }
      
      if (otherOrders.length > 0) {
        console.log(chalk.gray(`  🧹 Cleaned up ${otherOrders.length} non-TP/SL orders`))
      }
    } catch (error) {
      // Silently ignore cleanup errors
    }
  }
  
  private async cleanupEntryHuntingOrders() {
    try {
      // Get all open orders
      const result = await this.mcpClient!.callTool({
        name: 'get_open_orders',
        arguments: {}
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      const openOrders = response.orders || []
      
      if (openOrders.length === 0) return
      
      console.log(chalk.gray(`\n🧹 Found ${openOrders.length} open orders while in ENTRY_HUNTING mode`))
      
      // Group orders by symbol
      const ordersBySymbol: Record<string, any[]> = {}
      for (const order of openOrders) {
        if (!ordersBySymbol[order.symbol]) {
          ordersBySymbol[order.symbol] = []
        }
        ordersBySymbol[order.symbol].push(order)
      }
      
      let totalCancelled = 0
      
      // Check each symbol
      for (const [symbol, orders] of Object.entries(ordersBySymbol)) {
        // If it's our current market and we have an active marker order
        if (this.currentMarket?.symbol === symbol && this.markerOrder) {
          // Cancel any orders that aren't our current marker order
          for (const order of orders) {
            if (order.orderId.toString() !== this.markerOrder.orderId) {
              console.log(chalk.yellow(`  ⚠️  Cancelling non-marker order: ${order.side} ${order.type} #${order.orderId}`))
              await this.mcpClient!.callTool({
                name: 'cancel_order',
                arguments: {
                  symbol: order.symbol,
                  orderId: order.orderId
                }
              }).catch(() => {})
              totalCancelled++
            }
          }
        } else {
          // Cancel ALL orders for symbols we're not actively trading
          console.log(chalk.yellow(`  ⚠️  Cancelling ALL ${orders.length} orders for ${symbol} (not active market)`))
          
          for (const order of orders) {
            console.log(chalk.gray(`    - ${order.side} ${order.type} #${order.orderId}`))
            await this.mcpClient!.callTool({
              name: 'cancel_order',
              arguments: {
                symbol: order.symbol,
                orderId: order.orderId
              }
            }).catch(() => {})
            totalCancelled++
          }
        }
      }
      
      if (totalCancelled > 0) {
        console.log(chalk.gray(`  🧹 Cleaned up ${totalCancelled} dangling orders`))
      }
    } catch (error) {
      // Silently ignore cleanup errors
    }
  }

  private async cleanup() {
    console.log(chalk.gray('\nCleaning up...'))
    
    this.clearExitTimers()
    
    if (this.orderMonitorInterval) {
      clearInterval(this.orderMonitorInterval)
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
    
    if (this.websocket) {
      this.websocket.disconnect()
    }
    
    if (this.userDataWS) {
      this.userDataWS.disconnect()
    }
    
    if (this.mcpClient) {
      await this.mcpClient.close()
    }
    
    console.log(chalk.gray('Goodbye!'))
  }
}

// CLI setup
const program = new Command()
  .name('liquidity-scalping')
  .description('Liquidity scalping strategy for Binance futures')
  .version('0.2.0')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options) => {
    const strategy = new LiquidityScalpingStrategy()
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\nReceived SIGINT, shutting down gracefully...'))
      await strategy['cleanup']()
      process.exit(0)
    })
    
    await strategy.start()
  })

program.parse()
