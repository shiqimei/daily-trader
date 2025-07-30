import { OrderbookSnapshot } from '../types/orderbook'
import { CircularBuffer } from '../utils/CircularBuffer'

interface Trade {
  price: number
  quantity: number
  side: 'BUY' | 'SELL'
  timestamp: number
}

interface ImbalanceMetrics {
  priceImpactImbalance: number
  orderbookPressure: number
  microstructureFlowImbalance: number
  flowToxicity: number
  flowDirection: number
  fakeBidWall: boolean
  fakeAskWall: boolean
}

interface EntrySignal {
  side: 'BUY' | 'SELL' | null
  entryPrice: number
  metrics: ImbalanceMetrics
}

export class OrderFlowImbalance {
  private orderbookHistory: CircularBuffer<OrderbookSnapshot>
  private tradeHistory: CircularBuffer<Trade>
  private spreadHistory: CircularBuffer<number>
  
  constructor(
    private readonly tickSize: number,
    private readonly atrValue: number,
    private readonly avgTradeSize: number,
    private readonly avgSpread: number,
    private readonly windowSize: number = 100
  ) {
    this.orderbookHistory = new CircularBuffer(windowSize)
    this.tradeHistory = new CircularBuffer(1000)
    this.spreadHistory = new CircularBuffer(50)
  }
  
  /**
   * Calculate the cost asymmetry of buying vs selling a fixed volume
   */
  private calculatePriceImpactImbalance(orderbook: OrderbookSnapshot, baseVolume: number): number {
    const bids = orderbook.bids
    const asks = orderbook.asks
    
    // Calculate cost to buy baseVolume
    let buyVolume = 0
    let buyCost = 0
    let remaining = baseVolume
    
    for (const ask of asks) {
      if (remaining <= 0) break
      const executed = Math.min(remaining, ask.size)
      buyCost += executed * ask.price
      buyVolume += executed
      remaining -= executed
    }
    
    const avgBuyPrice = buyVolume > 0 ? buyCost / buyVolume : asks[0].price
    
    // Calculate revenue from selling baseVolume
    let sellVolume = 0
    let sellRevenue = 0
    remaining = baseVolume
    
    for (const bid of bids) {
      if (remaining <= 0) break
      const executed = Math.min(remaining, bid.size)
      sellRevenue += executed * bid.price
      sellVolume += executed
      remaining -= executed
    }
    
    const avgSellPrice = sellVolume > 0 ? sellRevenue / sellVolume : bids[0].price
    
    // Calculate relative impact
    const midPrice = (bids[0].price + asks[0].price) / 2
    const buyImpact = (avgBuyPrice - midPrice) / midPrice
    const sellImpact = (midPrice - avgSellPrice) / midPrice
    
    // Normalized imbalance: positive means easier to push price up
    if (buyImpact + sellImpact > 0) {
      return (sellImpact - buyImpact) / (sellImpact + buyImpact)
    }
    return 0
  }
  
  /**
   * Calculate resistance to price movement in each direction
   */
  private calculateOrderbookPressure(orderbook: OrderbookSnapshot): number {
    const bids = orderbook.bids.slice(0, 10)
    const asks = orderbook.asks.slice(0, 10)
    
    // Weight by inverse distance from best price
    const bidResistance = bids.reduce((sum, level, i) => 
      sum + level.size / (1 + i), 0)
    const askResistance = asks.reduce((sum, level, i) => 
      sum + level.size / (1 + i), 0)
    
    // Normalize
    if (bidResistance + askResistance > 0) {
      return (bidResistance - askResistance) / (bidResistance + askResistance)
    }
    return 0
  }
  
  /**
   * Calculate flow toxicity and directional pressure
   */
  private calculateFlowToxicity(trades: Trade[], lookback: number = 50): [number, number] {
    const recentTrades = trades.slice(-lookback)
    if (recentTrades.length === 0) return [0, 0]
    
    let buyVolume = 0
    let sellVolume = 0
    let buyAggressive = 0
    let sellAggressive = 0
    
    for (const trade of recentTrades) {
      if (trade.side === 'BUY') {
        buyVolume += trade.quantity
        // Large trades are more likely informed
        if (trade.quantity > 2 * this.avgTradeSize) {
          buyAggressive += trade.quantity
        }
      } else {
        sellVolume += trade.quantity
        if (trade.quantity > 2 * this.avgTradeSize) {
          sellAggressive += trade.quantity
        }
      }
    }
    
    const totalVolume = buyVolume + sellVolume
    if (totalVolume > 0) {
      const flowImbalance = (buyVolume - sellVolume) / totalVolume
      const aggressiveRatio = (buyAggressive - sellAggressive) / totalVolume
      return [Math.abs(aggressiveRatio), flowImbalance]
    }
    
    return [0, 0]
  }
  
  /**
   * Calculate microstructure flow imbalance
   */
  private calculateMicrostructureImbalance(
    orderbook: OrderbookSnapshot, 
    trades: Trade[]
  ): number {
    const recentWindow = 50  // Increased window for more stable calculation
    const recentTrades = trades.slice(-recentWindow)
    
    // Return 0 if not enough trades
    if (recentTrades.length < 2) {
      return 0
    }
    
    // Calculate buy and sell volumes
    let buyVolume = 0
    let sellVolume = 0
    
    for (const trade of recentTrades) {
      if (trade.side === 'BUY') {
        buyVolume += trade.quantity
      } else {
        sellVolume += trade.quantity
      }
    }
    
    // Calculate time span in seconds (not milliseconds)
    const timeSpanSeconds = (recentTrades[recentTrades.length - 1].timestamp - recentTrades[0].timestamp) / 1000
    if (timeSpanSeconds <= 0) return 0
    
    // Calculate consumption rates per second
    const buyRatePerSecond = buyVolume / timeSpanSeconds
    const sellRatePerSecond = sellVolume / timeSpanSeconds
    
    // Get orderbook liquidity at best levels
    const askLiquidity = orderbook.asks[0].size
    const bidLiquidity = orderbook.bids[0].size
    
    // Calculate depletion times in seconds
    const askDepletionTime = buyRatePerSecond > 0 ? askLiquidity / buyRatePerSecond : 1000
    const bidDepletionTime = sellRatePerSecond > 0 ? bidLiquidity / sellRatePerSecond : 1000
    
    // Calculate relative pressure (normalized between -1 and 1)
    // Faster depletion = higher pressure
    const upwardPressure = Math.min(10 / askDepletionTime, 1)  // Normalized with 10 second baseline
    const downwardPressure = Math.min(10 / bidDepletionTime, 1)
    
    // Return the imbalance
    return upwardPressure - downwardPressure
  }
  
  /**
   * Detect fake walls
   */
  private detectFakeWalls(orderbook: OrderbookSnapshot): [boolean, boolean] {
    const historicalAvgSize = this.avgTradeSize * 10
    let fakeBidWall = false
    let fakeAskWall = false
    
    // Check for abnormally large orders in first 5 levels
    for (let i = 0; i < Math.min(5, orderbook.bids.length); i++) {
      if (orderbook.bids[i].size > 5 * historicalAvgSize) {
        fakeBidWall = true
        break
      }
    }
    
    for (let i = 0; i < Math.min(5, orderbook.asks.length); i++) {
      if (orderbook.asks[i].size > 5 * historicalAvgSize) {
        fakeAskWall = true
        break
      }
    }
    
    return [fakeBidWall, fakeAskWall]
  }
  
  /**
   * Check if market conditions are suitable for mean reversion
   */
  private checkMarketRegime(orderbook: OrderbookSnapshot): boolean {
    const currentSpread = orderbook.asks[0].price - orderbook.bids[0].price
    const spreads = this.spreadHistory.getAll()
    const avgSpread = spreads.length >= 20 
      ? spreads.reduce((sum, s) => sum + s, 0) / spreads.length 
      : this.avgSpread
    
    // Check conditions
    const normalSpread = currentSpread >= 0.5 * avgSpread && currentSpread <= 2 * avgSpread
    const sufficientLiquidity = orderbook.bids.length >= 5 && orderbook.asks.length >= 5
    const stableMarket = spreads.length >= 20 
      ? Math.sqrt(spreads.reduce((sum, s) => sum + Math.pow(s - avgSpread, 2), 0) / spreads.length) < 2 * this.tickSize
      : true
    
    return normalSpread && sufficientLiquidity && stableMarket
  }
  
  /**
   * Update with new orderbook and generate entry signal
   */
  update(orderbook: OrderbookSnapshot, newTrades: Trade[] = []): EntrySignal {
    // Check if orderbook is valid
    if (!orderbook.bids.length || !orderbook.asks.length) {
      return { side: null, entryPrice: 0, metrics: {} as ImbalanceMetrics }
    }
    
    // Update history
    this.orderbookHistory.push(orderbook)
    this.spreadHistory.push(orderbook.asks[0].price - orderbook.bids[0].price)
    
    // Add new trades
    for (const trade of newTrades) {
      this.tradeHistory.push(trade)
    }
    
    // Check market regime
    if (!this.checkMarketRegime(orderbook)) {
      return { side: null, entryPrice: 0, metrics: {} as ImbalanceMetrics }
    }
    
    // Calculate metrics
    const baseVolume = this.avgTradeSize * 50
    const priceImpactImbalance = this.calculatePriceImpactImbalance(orderbook, baseVolume)
    const orderbookPressure = this.calculateOrderbookPressure(orderbook)
    const microstructureFlowImbalance = this.calculateMicrostructureImbalance(
      orderbook, 
      this.tradeHistory.getAll()
    )
    const [flowToxicity, flowDirection] = this.calculateFlowToxicity(
      this.tradeHistory.getAll()
    )
    const [fakeBidWall, fakeAskWall] = this.detectFakeWalls(orderbook)
    
    const metrics: ImbalanceMetrics = {
      priceImpactImbalance,
      orderbookPressure,
      microstructureFlowImbalance,
      flowToxicity,
      flowDirection,
      fakeBidWall,
      fakeAskWall
    }
    
    // Entry conditions for LONG (buy) - STRICTER THRESHOLDS
    const buyConditions = [
      priceImpactImbalance < -0.8,  // VERY heavy sell pressure in book (was -0.6)
      Math.abs(microstructureFlowImbalance) < 0.2,  // More balanced flow required (was 0.3)
      flowToxicity < 0.3,  // Lower toxicity threshold (was 0.4)
      fakeAskWall,  // Potential fake sell wall
      flowDirection > -0.5,  // Stricter flow direction (was -0.7)
      orderbookPressure < -0.4  // Additional condition: bid resistance must be stronger
    ]
    
    // Entry conditions for SHORT (sell) - STRICTER THRESHOLDS
    const sellConditions = [
      priceImpactImbalance > 0.8,  // VERY heavy buy pressure in book (was 0.6)
      Math.abs(microstructureFlowImbalance) < 0.2,  // More balanced flow required (was 0.3)
      flowToxicity < 0.3,  // Lower toxicity threshold (was 0.4)
      fakeBidWall,  // Potential fake buy wall
      flowDirection < 0.5,  // Stricter flow direction (was 0.7)
      orderbookPressure > 0.4  // Additional condition: ask resistance must be stronger
    ]
    
    // Generate signals - REQUIRE ALL CONDITIONS
    const buyScore = buyConditions.filter(c => c).length
    const sellScore = sellConditions.filter(c => c).length
    
    if (buyScore >= 5) {  // Increased from 4 to 5 (need 5 out of 6 conditions)
      // Place buy order one tick below best bid
      const entryPrice = orderbook.bids[0].price - this.tickSize
      return { side: 'BUY', entryPrice, metrics }
    } else if (sellScore >= 5) {  // Increased from 4 to 5
      // Place sell order one tick above best ask
      const entryPrice = orderbook.asks[0].price + this.tickSize
      return { side: 'SELL', entryPrice, metrics }
    }
    
    return { side: null, entryPrice: 0, metrics }
  }
  
  /**
   * Inject historical trade data (for WebSocket trades)
   */
  addTrade(price: number, quantity: number, isBuyerMaker: boolean, timestamp: number): void {
    const trade: Trade = {
      price,
      quantity,
      side: isBuyerMaker ? 'SELL' : 'BUY',  // If buyer is maker, it's a sell order hitting the bid
      timestamp
    }
    this.tradeHistory.push(trade)
  }
}