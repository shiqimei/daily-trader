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
 *      <> Move SL to BL once we have 5bps profit to cover the SL fees.
 *      <> When a position holds over 2 mins and we have 5+ bps, closed it using market order immediately to avoid risks.
 * 5. Loop above steps, if we are in entry-hunting mode, just to make sure we entry following rules listed above.
 *
 * Position Management:
 *  <> 30% Rule: Risk per trade never exceeds 30%, use calculate_position_size for position calculation
 *  <> TP/SL: Set immediately after entry, no exceptions
 *  <> R:R = ATR : 0.5ATR = 2:1
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

dayjs.extend(utc)

// State machine states
type State = 'INITIALIZING' | 'SEARCHING_MARKET' | 'ENTRY_HUNTING' | 'POSITION_ACTIVE' | 'ERROR'

// Position types
interface Position {
  symbol: string
  side: 'LONG' | 'SHORT'
  entryPrice: number
  size: number
  originalSize: number  // Track original position size for partial exit calculations
  entryTime: number
  tpOrderId?: string
  slOrderId?: string
  tpPrice: number
  slPrice: number
  unrealizedPnl?: number
  breakEvenMoved?: boolean
  exits5min?: boolean   // Track if 5-minute exit was executed
  exits30min?: boolean  // Track if 30-minute exit was executed
  exits1hr?: boolean    // Track if 1-hour exit was executed
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
  volumeUSDT24h: number
}

class LiquidityScalpingStrategy {
  private state: State = 'INITIALIZING'
  private mcpClient: Client | null = null
  private websocket: BinanceWebsocket | null = null
  private orderbookDynamics: OrderbookDynamics | null = null
  private position: Position | null = null
  private markerOrder: MarkerOrder | null = null
  private currentMarket: MarketData | null = null
  private accountBalance: number = 0
  private lastPatternCheckTime: number = 0
  private patternCheckInterval: number = 1000 // Check patterns only once per second
  private positionStartTime: number = 0
  private exitTimeouts: NodeJS.Timeout[] = []
  private orderMonitorInterval: NodeJS.Timeout | null = null
  private lastSLOrderAttempt: number = 0
  private slOrderCooldown: number = 30000 // 30 seconds cooldown between SL order attempts

  constructor() {}

  async start() {
    try {
      console.log(chalk.cyan('=== Liquidity Scalping Strategy v0.2.0 ==='))
      console.log(chalk.yellow('Mode: LIVE TRADING'))
      
      await this.initializeMCPClient()
      await this.getAccountInfo()
      
      // Check for existing positions
      const hasExistingPosition = await this.checkExistingPositions()
      
      if (hasExistingPosition) {
        this.state = 'POSITION_ACTIVE'
        console.log(chalk.yellow('\n⚡ Resuming management of existing position'))
      } else {
        this.state = 'SEARCHING_MARKET'
      }
      
      // Set up periodic position sync check
      setInterval(() => this.syncPositionState(), 5000) // Every 5 seconds
      
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
    
    const account = JSON.parse((result.content as any)[0].text)
    
    // Check if we have USDC balance
    const usdcAsset = account.assets?.find((a: any) => a.asset === 'USDC')
    if (usdcAsset) {
      this.accountBalance = parseFloat(usdcAsset.availableBalance || '0')
    } else {
      // Use general available balance as fallback
      this.accountBalance = parseFloat(account.availableBalance || '0')
    }
    
    // Show more detailed balance info
    console.log(chalk.green(`✓ Account balance:`))
    console.log(chalk.gray(`  Available: $${this.accountBalance.toFixed(2)}`))
    console.log(chalk.gray(`  Total Wallet: $${parseFloat(account.totalWalletBalance || '0').toFixed(2)}`))
    if (account.totalUnrealizedProfit && parseFloat(account.totalUnrealizedProfit) !== 0) {
      console.log(chalk.gray(`  Unrealized PnL: $${parseFloat(account.totalUnrealizedProfit).toFixed(2)}`))
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
        
        this.position = {
          symbol: openPosition.symbol,
          side,
          entryPrice,
          size: Math.abs(positionAmt),
          originalSize: Math.abs(positionAmt), // Assume current size is original
          entryTime: Date.now() - 60000, // Assume 1 minute old if unknown
          tpPrice: this.roundToTickSize(
            side === 'LONG' 
              ? entryPrice + atrValue
              : entryPrice - atrValue
          ),
          slPrice: this.roundToTickSize(
            side === 'LONG'
              ? entryPrice - (atrValue * 0.5)
              : entryPrice + (atrValue * 0.5)
          ),
          unrealizedPnl: parseFloat(openPosition.unRealizedProfit)
        }
        
        // Initialize orderbook for this symbol
        await this.initializeOrderbook()
        
        // Check for existing TP/SL orders
        await this.checkExistingTPSLOrders()
        
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
      
      const orders = JSON.parse((result.content as any)[0].text)
      
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
      volumeUSDT24h: parseFloat(selected.quote_volume)
    }
    
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
      
      // Update minOrderSize from exchange info
      const lotSizeFilter = info.filters.find((f: any) => f.filterType === 'LOT_SIZE')
      if (lotSizeFilter) {
        this.currentMarket!.minOrderSize = parseFloat(lotSizeFilter.minQty)
      }
    } catch (error) {
      console.warn(chalk.yellow('Failed to get exchange info, using default min order size'))
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
    const positionSize = this.calculatePositionSize()
    
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
    } catch (error: any) {
      // Only log if it's not a Post-Only rejection
      if (!error.message || !error.message.includes('could not be executed as maker')) {
        console.error(chalk.red('Failed to place marker order:'), error)
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
    } catch (error: any) {
      console.error(chalk.red(`Failed to cancel marker order #${orderId}:`), error.message || error)
      // Still clear the marker order reference on error
      this.markerOrder = null
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
    
    this.position = {
      symbol: this.markerOrder.symbol,
      side,
      entryPrice: this.markerOrder.price,
      size: this.markerOrder.size,
      originalSize: this.markerOrder.size,
      entryTime: Date.now(),
      tpPrice: this.roundToTickSize(
        side === 'LONG' 
          ? this.markerOrder.price + atrValue  // TP at 1 ATR (2R)
          : this.markerOrder.price - atrValue
      ),
      slPrice: this.roundToTickSize(
        side === 'LONG'
          ? this.markerOrder.price - (atrValue * 0.5)  // SL at 0.5 ATR (1R)
          : this.markerOrder.price + (atrValue * 0.5)
      )
    }
    
    this.markerOrder = null
    this.positionStartTime = Date.now()
    
    console.log(chalk.green(`\n✓ Position opened: ${side} at ${this.position.entryPrice}`))
    console.log(chalk.gray(`  TP: ${this.position.tpPrice.toFixed(4)} (+${this.currentMarket!.atrBps}bps)`))
    console.log(chalk.gray(`  SL: ${this.position.slPrice.toFixed(4)} (-${this.currentMarket!.atrBps * 0.5}bps)`))
    
    await this.placeTPSLOrders()
    this.setupExitTimers()
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
            price: this.position.tpPrice,
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
    // Clear any existing timers
    this.clearExitTimers()
    
    // 5 minute timer - exit 50% if no movement
    this.exitTimeouts.push(
      setTimeout(() => this.checkTimeBasedExit(5, 0, 0.5), 5 * 60 * 1000)
    )
    
    // 30 minute timer - exit 50% if profit < 1R
    this.exitTimeouts.push(
      setTimeout(() => this.checkTimeBasedExit(30, 0, 0.5), 30 * 60 * 1000)
    )
    
    // 1 hour timer - exit 80% regardless
    this.exitTimeouts.push(
      setTimeout(() => this.checkTimeBasedExit(60, 0, 0.8), 60 * 60 * 1000)
    )
  }

  private async checkTimeBasedExit(minutes: number, minProfitBps: number, exitPercent: number) {
    if (!this.position) return
    
    const pnlBps = this.calculatePnlBps()
    
    // Special handling for different time-based rules
    let shouldExit = false
    let exitReason = ''
    
    if (minutes === 5 && !this.position.exits5min) {
      // 5min rule: Exit if no movement (flat P&L)
      if (Math.abs(pnlBps) < 2) { // Less than 2bps movement considered "no movement"
        shouldExit = true
        exitReason = 'no movement'
        this.position.exits5min = true
      }
    } else if (minutes === 30 && !this.position.exits30min) {
      // 30min rule: Exit if profit < 1R (1R = 0.5 ATR)
      const oneRInBps = this.currentMarket!.atrBps * 0.5
      if (pnlBps < oneRInBps) {
        shouldExit = true
        exitReason = `profit < 1R (${oneRInBps.toFixed(0)}bps)`
        this.position.exits30min = true
      }
    } else if (minutes === 60 && !this.position.exits1hr) {
      // 1hr rule: Exit regardless of P&L
      shouldExit = true
      exitReason = 'time limit'
      this.position.exits1hr = true
    }
    
    if (shouldExit) {
      console.log(chalk.yellow(`\n⏰ ${minutes}min timer: Exiting ${exitPercent * 100}% of position (${exitReason}, PnL: ${pnlBps.toFixed(1)}bps)`))
      await this.exitPosition(exitPercent)
    }
  }

  private async managePosition() {
    if (!this.position) {
      this.state = 'ENTRY_HUNTING'
      return
    }
    
    // First check if we've breached SL level without an order
    const currentPrice = this.currentMarket!.price
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
    
    const pnlBps = this.calculatePnlBps()
    const holdTime = (Date.now() - this.position!.entryTime) / 1000 / 60 // minutes
    
    // Move SL to breakeven at 5bps profit
    if (pnlBps >= 5 && !this.position!.breakEvenMoved) {
      await this.moveSLToBreakeven()
    }
    
    // Exit if held > 2 mins and profit >= 5bps
    if (holdTime > 2 && pnlBps >= 5) {
      console.log(chalk.yellow(`\n⚡ Quick exit: ${pnlBps.toFixed(1)}bps profit after ${holdTime.toFixed(1)}min`))
      await this.exitPosition(1.0)
    }
    
    // Check position status periodically
    await this.checkPositionStatus()
  }
  
  private async ensureTPSLOrders() {
    if (!this.position) return
    
    try {
      // Check if we need to place TP order
      if (!this.position.tpOrderId) {
        console.log(chalk.yellow('TP order missing, placing now...'))
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
        const now = Date.now()
        if (now - this.lastSLOrderAttempt > this.slOrderCooldown) {
          console.log(chalk.yellow('SL order missing, placing now...'))
          this.lastSLOrderAttempt = now
          await this.placeSLOrder()
        }
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
        // Retry with GTC
        const tpRetryResult = await this.mcpClient!.callTool({
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
        })
        const tpOrder = JSON.parse((tpRetryResult.content as any)[0].text)
        this.position.tpOrderId = tpOrder.orderId
        console.log(chalk.green(`✓ TP order placed #${tpOrder.orderId} at ${this.position.tpPrice.toFixed(4)} (GTC)`))
      } else {
        const tpOrder = JSON.parse(tpResponseText)
        this.position.tpOrderId = tpOrder.orderId
        console.log(chalk.green(`✓ TP order placed #${tpOrder.orderId} at ${this.position.tpPrice.toFixed(4)} (GTX)`))
      }
    } catch (error) {
      console.error(chalk.red('Failed to place TP order:'), error)
    }
  }
  
  private async placeSLOrder() {
    if (!this.position) return
    
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
    } catch (error) {
      console.error(chalk.red('Failed to place SL order:'), error)
      this.position!.slOrderId = undefined
    }
  }
  
  private async checkPositionStatus() {
    // Check if position exists by querying open positions
    try {
      const result = await this.mcpClient!.callTool({
        name: 'get_positions',
        arguments: {}
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      const positions = response.positions || []
      const currentPosition = positions.find((p: any) => p.symbol === this.position?.symbol)
      
      if (!currentPosition || currentPosition.positionAmt === 0) {
        // Position closed
        console.log(chalk.green(`\n✓ Position closed`))
        
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
  }

  private calculatePnlBps(): number {
    if (!this.position) return 0
    
    const currentPrice = this.currentMarket!.price
    const pnlPercent = this.position.side === 'LONG'
      ? (currentPrice - this.position.entryPrice) / this.position.entryPrice
      : (this.position.entryPrice - currentPrice) / this.position.entryPrice
    
    return pnlPercent * 10000 // Convert to basis points
  }

  private async moveSLToBreakeven() {
    if (!this.position || this.position.breakEvenMoved) return
    
    // Add enough to cover fees (maker 0.02% + taker 0.04% = 0.06% = 6bps)
    const feeBuffer = this.position.entryPrice * 0.0006 // 6bps
    const minBuffer = Math.max(feeBuffer, this.currentMarket!.tickSize * 2) // At least 2 ticks
    
    const newSL = this.roundToTickSize(
      this.position.side === 'LONG'
        ? this.position.entryPrice + minBuffer
        : this.position.entryPrice - minBuffer
    )
    
    try {
      // Cancel existing SL order
      if (this.position.slOrderId) {
        try {
          await this.mcpClient!.callTool({
            name: 'cancel_order',
            arguments: {
              symbol: this.position.symbol,
              orderId: this.position.slOrderId
            }
          })
          console.log(chalk.yellow(`✓ Cancelled old SL order #${this.position.slOrderId}`))
        } catch (error) {
          console.warn(chalk.yellow('Could not cancel old SL order, it may have been filled or expired'))
        }
      }
      
      // Place new SL at breakeven
      const slResult = await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          quantity: this.position.size,
          stopPrice: newSL,
          reduceOnly: true
        }
      })
      
      const order = JSON.parse((slResult.content as any)[0].text)
      this.position.slOrderId = order.orderId
      this.position.slPrice = newSL
      this.position.breakEvenMoved = true
      
      console.log(chalk.green(`✓ SL moved to breakeven #${order.orderId} at ${newSL.toFixed(4)}`))
    } catch (error) {
      console.error(chalk.red('Failed to move SL:'), error)
    }
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
    // 30% risk rule
    const riskAmount = this.accountBalance * 0.30
    const atrValue = this.currentMarket!.atrValue
    const slDistance = atrValue * 0.5 // SL is 0.5 ATR away
    
    // Position size = Risk Amount / SL Distance
    let positionSize = riskAmount / slDistance
    
    // Apply max position limit (optional safety)
    const maxSize = this.accountBalance / this.currentMarket!.price * 2 // Max 2x leverage
    positionSize = Math.min(positionSize, maxSize)
    
    // Round to min order size precision
    const minSize = this.currentMarket!.minOrderSize
    const precision = this.getPrecisionFromMinSize(minSize)
    positionSize = parseFloat(positionSize.toFixed(precision))
    
    // Ensure at least min size
    if (positionSize < minSize) {
      positionSize = minSize
    }
    
    return positionSize
  }

  private getPrecisionFromMinSize(minSize: number): number {
    // Convert minSize to string and count decimals
    const str = minSize.toString()
    const parts = str.split('.')
    return parts.length > 1 ? parts[1].length : 0
  }

  private clearExitTimers() {
    this.exitTimeouts.forEach(timeout => clearTimeout(timeout))
    this.exitTimeouts = []
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
        console.log(chalk.yellow('⚠️  Found active position but bot thinks none exists - stopping entry hunting'))
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

  private async cleanup() {
    console.log(chalk.gray('\nCleaning up...'))
    
    this.clearExitTimers()
    
    if (this.orderMonitorInterval) {
      clearInterval(this.orderMonitorInterval)
    }
    
    if (this.websocket) {
      this.websocket.disconnect()
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
