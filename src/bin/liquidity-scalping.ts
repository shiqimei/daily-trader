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
import { BinanceOrderbookWS } from '../websocket/BinanceOrderbookWS'
import { OrderbookDynamics } from '../analysis/OrderbookDynamics'
import { DynamicPattern, OrderbookSnapshot, TradingConfig } from '../types/orderbook'
import chalk from 'chalk'
import { Command } from 'commander'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'

dayjs.extend(utc)

// State machine states
type State = 'INITIALIZING' | 'SEARCHING_MARKET' | 'ENTRY_HUNTING' | 'POSITION_ACTIVE' | 'ERROR'

// Position types
interface Position {
  symbol: string
  side: 'LONG' | 'SHORT'
  entryPrice: number
  size: number
  entryTime: number
  tpOrderId?: string
  slOrderId?: string
  tpPrice: number
  slPrice: number
  unrealizedPnl?: number
  breakEvenMoved?: boolean
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
  private websocket: BinanceOrderbookWS | null = null
  private orderbookDynamics: OrderbookDynamics | null = null
  private position: Position | null = null
  private markerOrder: MarkerOrder | null = null
  private currentMarket: MarketData | null = null
  private accountBalance: number = 0
  private lastPatternCheckTime: number = 0
  private patternCheckInterval: number = 100 // ms
  private positionStartTime: number = 0
  private exitTimeouts: NodeJS.Timeout[] = []

  constructor() {}

  async start() {
    try {
      console.log(chalk.cyan('=== Liquidity Scalping Strategy v0.2.0 ==='))
      console.log(chalk.yellow('Mode: LIVE TRADING'))
      
      await this.initializeMCPClient()
      await this.getAccountInfo()
      
      this.state = 'SEARCHING_MARKET'
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
    this.accountBalance = parseFloat(account.totalBalance)
    console.log(chalk.green(`✓ Account balance: $${this.accountBalance.toFixed(2)}`))
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
        min_atr_bps: 40,
        max_atr_bps: 80,
        sort_by: 'atr_bps_5m',
        sort_order: 'asc',
        limit: 10
      }
    })
    
    const symbols = JSON.parse((result.content as any)[0].text)
    if (symbols.length === 0) {
      console.log(chalk.yellow('No suitable markets found. Retrying in 30s...'))
      await new Promise(resolve => setTimeout(resolve, 30000))
      return
    }
    
    // Select the first symbol
    const selected = symbols[0]
    this.currentMarket = {
      symbol: selected.symbol,
      atrBps: selected.atr_bps_5m,
      atrValue: selected.atr_value_5m,
      price: selected.price,
      tickSize: selected.tick_size,
      minOrderSize: selected.min_order_size,
      volumeUSDT24h: selected.volume_usdt_24h
    }
    
    console.log(chalk.green(`✓ Selected market: ${this.currentMarket.symbol}`))
    console.log(chalk.gray(`  ATR: ${this.currentMarket.atrBps}bps ($${this.currentMarket.atrValue.toFixed(4)})`))
    console.log(chalk.gray(`  Volume 24h: $${(this.currentMarket.volumeUSDT24h / 1e6).toFixed(2)}M`))
    
    await this.initializeOrderbook()
    this.state = 'ENTRY_HUNTING'
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
    this.websocket = new BinanceOrderbookWS(
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
    const now = Date.now()
    if (now - this.lastPatternCheckTime < this.patternCheckInterval) {
      return
    }
    this.lastPatternCheckTime = now
    
    const patterns = this.orderbookDynamics!.getCurrentPatterns()
    const derivatives = this.orderbookDynamics!.getCurrentDerivatives()
    const stats = this.orderbookDynamics!.getStats()
    
    // Check spread condition (must be > 1 tick)
    const spreadTicks = stats.avgSpread / this.currentMarket!.tickSize
    if (spreadTicks <= 1) {
      return // No gap to place maker order
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
    // Long signal: bids LIQUIDITY_SURGE or asks LIQUIDITY_WITHDRAWAL
    if ((pattern.type === 'LIQUIDITY_SURGE' && pattern.side === 'BID' && pattern.strength > 60) ||
        (pattern.type === 'LIQUIDITY_WITHDRAWAL' && pattern.side === 'ASK' && pattern.strength > 70)) {
      // Place buy order just below best ask
      const price = this.currentMarket!.price - this.currentMarket!.tickSize
      return { side: 'BUY', price }
    }
    
    // Short signal: asks LIQUIDITY_SURGE or bids LIQUIDITY_WITHDRAWAL
    if ((pattern.type === 'LIQUIDITY_SURGE' && pattern.side === 'ASK' && pattern.strength > 60) ||
        (pattern.type === 'LIQUIDITY_WITHDRAWAL' && pattern.side === 'BID' && pattern.strength > 70)) {
      // Place sell order just above best bid
      const price = this.currentMarket!.price + this.currentMarket!.tickSize
      return { side: 'SELL', price }
    }
    
    return null
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
          order_type: 'LIMIT',
          quantity: positionSize,
          price: signal.price,
          time_in_force: 'GTX' // Post-only
        }
      })
      
      const order = JSON.parse((result.content as any)[0].text)
      this.markerOrder = {
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        price: order.price,
        size: order.origQty,
        timeInForce: 'GTX'
      }
      
      console.log(chalk.green(`✓ Placed ${signal.side} marker order at ${signal.price}`))
    } catch (error) {
      console.error(chalk.red('Failed to place marker order:'), error)
    }
  }

  private async cancelMarkerOrder() {
    if (!this.markerOrder) return
    
    try {
      await this.mcpClient!.callTool({
        name: 'cancel_order',
        arguments: {
          symbol: this.markerOrder.symbol,
          order_id: this.markerOrder.orderId
        }
      })
      
      console.log(chalk.yellow(`✓ Cancelled marker order ${this.markerOrder.orderId}`))
      this.markerOrder = null
    } catch (error) {
      console.error(chalk.red('Failed to cancel marker order:'), error)
    }
  }

  private async onOrderFilled() {
    if (!this.markerOrder) return
    
    const side = this.markerOrder.side === 'BUY' ? 'LONG' : 'SHORT'
    const atrValue = this.currentMarket!.atrValue
    
    this.position = {
      symbol: this.markerOrder.symbol,
      side,
      entryPrice: this.markerOrder.price,
      size: this.markerOrder.size,
      entryTime: Date.now(),
      tpPrice: side === 'LONG' 
        ? this.markerOrder.price + atrValue
        : this.markerOrder.price - atrValue,
      slPrice: side === 'LONG'
        ? this.markerOrder.price - (atrValue * 0.5)
        : this.markerOrder.price + (atrValue * 0.5)
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
      // Place TP order (maker)
      const tpResult = await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          order_type: 'LIMIT',
          quantity: this.position.size,
          price: this.position.tpPrice,
          time_in_force: 'GTX',
          reduce_only: true
        }
      })
      
      const tpOrder = JSON.parse((tpResult.content as any)[0].text)
      this.position.tpOrderId = tpOrder.orderId
      
      // Place SL order (stop market)
      const slResult = await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          order_type: 'STOP_MARKET',
          quantity: this.position.size,
          stop_price: this.position.slPrice,
          reduce_only: true
        }
      })
      
      const slOrder = JSON.parse((slResult.content as any)[0].text)
      this.position.slOrderId = slOrder.orderId
      
      console.log(chalk.green('✓ TP and SL orders placed'))
    } catch (error) {
      console.error(chalk.red('Failed to place TP/SL orders:'), error)
    }
  }

  private setupExitTimers() {
    // 5 minute timer - exit 50% if no movement
    this.exitTimeouts.push(
      setTimeout(() => this.checkTimeBasedExit(5, 0, 0.5), 5 * 60 * 1000)
    )
    
    // 30 minute timer - exit 50% if < 1R
    this.exitTimeouts.push(
      setTimeout(() => this.checkTimeBasedExit(30, this.currentMarket!.atrBps, 0.5), 30 * 60 * 1000)
    )
    
    // 1 hour timer - exit 80% regardless
    this.exitTimeouts.push(
      setTimeout(() => this.checkTimeBasedExit(60, -999, 0.8), 60 * 60 * 1000)
    )
  }

  private async checkTimeBasedExit(minutes: number, minProfitBps: number, exitPercent: number) {
    if (!this.position) return
    
    const pnlBps = this.calculatePnlBps()
    
    if (pnlBps < minProfitBps) {
      console.log(chalk.yellow(`\n⏰ ${minutes}min timer: Exiting ${exitPercent * 100}% of position (PnL: ${pnlBps.toFixed(1)}bps)`))
      await this.exitPosition(exitPercent)
    }
  }

  private async managePosition() {
    if (!this.position) {
      this.state = 'ENTRY_HUNTING'
      return
    }
    
    const pnlBps = this.calculatePnlBps()
    const holdTime = (Date.now() - this.position.entryTime) / 1000 / 60 // minutes
    
    // Move SL to breakeven at 5bps profit
    if (pnlBps >= 5 && !this.position.breakEvenMoved) {
      await this.moveSLToBreakeven()
    }
    
    // Exit if held > 2 mins and profit >= 5bps
    if (holdTime > 2 && pnlBps >= 5) {
      console.log(chalk.yellow(`\n⚡ Quick exit: ${pnlBps.toFixed(1)}bps profit after ${holdTime.toFixed(1)}min`))
      await this.exitPosition(1.0)
    }
    
  }
  
  private async checkPositionStatus() {
    // Check if position exists by querying open positions
    try {
      const result = await this.mcpClient!.callTool({
        name: 'get_positions',
        arguments: {}
      })
      
      const positions = JSON.parse((result.content as any)[0].text)
      const currentPosition = positions.find((p: any) => p.symbol === this.position?.symbol)
      
      if (!currentPosition || currentPosition.positionAmt === 0) {
        // Position closed
        console.log(chalk.green(`\n✓ Position closed`))
        this.position = null
        this.clearExitTimers()
        this.state = 'ENTRY_HUNTING'
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
    
    const newSL = this.position.side === 'LONG'
      ? this.position.entryPrice + this.currentMarket!.tickSize
      : this.position.entryPrice - this.currentMarket!.tickSize
    
    try {
      // Cancel old SL
      if (this.position.slOrderId) {
        await this.mcpClient!.callTool({
          name: 'cancel_order',
          arguments: {
            symbol: this.position.symbol,
            order_id: this.position.slOrderId
          }
        })
      }
      
      // Place new SL at breakeven
      const result = await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          order_type: 'STOP_MARKET',
          quantity: this.position.size,
          stop_price: newSL,
          reduce_only: true
        }
      })
      
      const order = JSON.parse((result.content as any)[0].text)
      this.position.slOrderId = order.orderId
      this.position.slPrice = newSL
      this.position.breakEvenMoved = true
      
      console.log(chalk.green(`✓ SL moved to breakeven at ${newSL}`))
    } catch (error) {
      console.error(chalk.red('Failed to move SL:'), error)
    }
  }

  private async exitPosition(percent: number) {
    if (!this.position) return
    
    const exitSize = Math.floor(this.position.size * percent)
    if (exitSize === 0) return
    
    try {
      await this.mcpClient!.callTool({
        name: 'place_order',
        arguments: {
          symbol: this.position.symbol,
          side: this.position.side === 'LONG' ? 'SELL' : 'BUY',
          order_type: 'MARKET',
          quantity: exitSize,
          reduce_only: true
        }
      })
      
      console.log(chalk.green(`✓ Exited ${exitSize} contracts at market`))
      
      this.position.size -= exitSize
      if (this.position.size === 0) {
        this.position = null
        this.clearExitTimers()
        this.state = 'ENTRY_HUNTING'
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
    
    // Round to min order size
    const minSize = this.currentMarket!.minOrderSize
    positionSize = Math.floor(positionSize / minSize) * minSize
    
    // Apply max position limit (optional safety)
    const maxSize = this.accountBalance / this.currentMarket!.price * 2 // Max 2x leverage
    positionSize = Math.min(positionSize, maxSize)
    
    return positionSize
  }

  private clearExitTimers() {
    this.exitTimeouts.forEach(timeout => clearTimeout(timeout))
    this.exitTimeouts = []
  }

  private async cleanup() {
    console.log(chalk.gray('\nCleaning up...'))
    
    this.clearExitTimers()
    
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
