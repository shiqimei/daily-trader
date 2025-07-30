import {
  Derivatives,
  DynamicPattern,
  MarketState,
  OrderbookSnapshot,
  OrderLevel,
  TradingConfig,
  TradingSignal
} from '../types/orderbook'
import { CircularBuffer } from '../utils/CircularBuffer'

export class OrderbookDynamics {
  private readonly orderbookHistory: CircularBuffer<OrderbookSnapshot>
  private readonly bidLiquidityHistory: CircularBuffer<number>
  private readonly askLiquidityHistory: CircularBuffer<number>
  private readonly spreadHistory: CircularBuffer<number>
  private readonly midPriceHistory: CircularBuffer<number>
  private readonly patternHistory: CircularBuffer<DynamicPattern>

  private lastSignalTime: number = 0
  private readonly signalCooldown: number = 3000 // milliseconds
  private lastPatternTime: Record<string, number> = {}
  private readonly patternCooldown: number = 2000 // 2 seconds between same pattern
  private readonly minDataPoints: number = 10 // Minimum data points before detecting patterns

  constructor(
    private readonly config: TradingConfig,
    private readonly windowSize: number = 20,
    private readonly depthLevels: number = 5,
    private readonly minSignalStrength: number = 60
  ) {
    this.orderbookHistory = new CircularBuffer(windowSize)
    this.bidLiquidityHistory = new CircularBuffer(windowSize)
    this.askLiquidityHistory = new CircularBuffer(windowSize)
    this.spreadHistory = new CircularBuffer(windowSize)
    this.midPriceHistory = new CircularBuffer(windowSize)
    this.patternHistory = new CircularBuffer(100)
  }

  update(orderbook: OrderbookSnapshot): TradingSignal | null {
    // Store orderbook
    this.orderbookHistory.push(orderbook)

    // Calculate and store metrics
    const bidLiquidity = this.calculateLiquidity(orderbook.bids, this.depthLevels)
    const askLiquidity = this.calculateLiquidity(orderbook.asks, this.depthLevels)
    const spread = this.calculateSpread(orderbook)
    const midPrice = this.calculateMidPrice(orderbook)

    this.bidLiquidityHistory.push(bidLiquidity)
    this.askLiquidityHistory.push(askLiquidity)
    this.spreadHistory.push(spread)
    this.midPriceHistory.push(midPrice)

    // Need at least 3 snapshots for derivatives
    if (this.orderbookHistory.length < 3) {
      return null
    }

    // Calculate derivatives
    const derivatives = this.calculateDerivatives()

    // Detect patterns
    const patterns = this.detectPatterns(derivatives, orderbook)
    patterns.forEach(p => this.patternHistory.push(p))

    // Generate signal if appropriate
    return this.generateSignal(derivatives, patterns, orderbook)
  }

  private calculateLiquidity(levels: OrderLevel[], depth: number): number {
    return levels.slice(0, depth).reduce((sum, level) => sum + level.size, 0)
  }

  private calculateSpread(orderbook: OrderbookSnapshot): number {
    if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return 0
    }
    return orderbook.asks[0].price - orderbook.bids[0].price
  }

  private calculateMidPrice(orderbook: OrderbookSnapshot): number {
    if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return 0
    }
    return (orderbook.bids[0].price + orderbook.asks[0].price) / 2
  }

  calculateDerivatives(): Derivatives {
    const bidLiquidity = this.bidLiquidityHistory.toArray()
    const askLiquidity = this.askLiquidityHistory.toArray()
    const spreads = this.spreadHistory.toArray()
    const prices = this.midPriceHistory.toArray()
    const orderbooks = this.orderbookHistory.toArray()

    const n = bidLiquidity.length
    if (n < 2) {
      return this.getEmptyDerivatives()
    }

    // Find an orderbook snapshot that's approximately 1 second ago
    const currentTime = orderbooks[n - 1].timestamp
    const targetTime = currentTime - 1000 // 1 second ago

    let compareIndex = -1
    for (let i = n - 2; i >= 0; i--) {
      if (orderbooks[i].timestamp <= targetTime) {
        compareIndex = i
        break
      }
    }

    // If we don't have data from 1 second ago, use the oldest available
    if (compareIndex === -1) {
      compareIndex = 0
    }

    // Time difference in seconds
    const dt = (orderbooks[n - 1].timestamp - orderbooks[compareIndex].timestamp) / 1000


    // Need at least 0.5 seconds of data for meaningful velocity
    if (dt < 0.5) {
      return this.getEmptyDerivatives()
    }

    // Velocities (first derivatives)
    const bidVelocity = (bidLiquidity[n - 1] - bidLiquidity[compareIndex]) / dt
    const askVelocity = (askLiquidity[n - 1] - askLiquidity[compareIndex]) / dt
    const spreadVelocity = (spreads[n - 1] - spreads[compareIndex]) / dt
    const priceVelocity = (prices[n - 1] - prices[compareIndex]) / dt

    // Relative rates (percentage change per second)
    // Use the average of start and end values as reference
    const avgBidLiquidity = (bidLiquidity[n - 1] + bidLiquidity[compareIndex]) / 2
    const avgAskLiquidity = (askLiquidity[n - 1] + askLiquidity[compareIndex]) / 2
    const bidRate = avgBidLiquidity > 0 ? bidVelocity / avgBidLiquidity : 0
    const askRate = avgAskLiquidity > 0 ? askVelocity / avgAskLiquidity : 0

    // Net flow and imbalance
    const netFlow = bidVelocity + askVelocity

    // Calculate imbalance ratio with safeguards
    let imbalanceRatio = 0
    if (Math.abs(askVelocity) > 0.0001) {
      imbalanceRatio = bidVelocity / askVelocity
      // Clamp to reasonable range
      imbalanceRatio = Math.max(-999, Math.min(999, imbalanceRatio))
    } else if (Math.abs(bidVelocity) > 0.0001) {
      imbalanceRatio = bidVelocity > 0 ? 999 : -999
    }

    // Final validation - ensure no NaN or Infinity values
    return {
      bidVelocity: isFinite(bidVelocity) ? bidVelocity : 0,
      askVelocity: isFinite(askVelocity) ? askVelocity : 0,
      bidRate: isFinite(bidRate) ? bidRate : 0,
      askRate: isFinite(askRate) ? askRate : 0,
      spreadVelocity: isFinite(spreadVelocity) ? spreadVelocity : 0,
      priceVelocity: isFinite(priceVelocity) ? priceVelocity : 0,
      netFlow: isFinite(netFlow) ? netFlow : 0,
      imbalanceRatio: isFinite(imbalanceRatio) ? imbalanceRatio : 0
    }
  }

  private detectPatterns(derivatives: Derivatives, orderbook: OrderbookSnapshot): DynamicPattern[] {
    const patterns: DynamicPattern[] = []
    
    // Need sufficient data points before detecting patterns
    if (this.orderbookHistory.length < this.minDataPoints) {
      return patterns
    }
    
    const avgLiquidity =
      (this.bidLiquidityHistory
        .toArray()
        .slice(-5)
        .reduce((a, b) => a + b, 0) +
        this.askLiquidityHistory
          .toArray()
          .slice(-5)
          .reduce((a, b) => a + b, 0)) /
      10

    // Get current mid price for pattern detection
    const midPrice = this.calculateMidPrice(orderbook)
    const timestamp = orderbook.timestamp
    
    // Helper function to check pattern cooldown
    const canAddPattern = (type: string, side: string): boolean => {
      const key = `${type}_${side}`
      const lastTime = this.lastPatternTime[key] || 0
      if (timestamp - lastTime < this.patternCooldown) {
        return false
      }
      return true
    }
    
    const addPattern = (pattern: DynamicPattern) => {
      const key = `${pattern.type}_${pattern.side}`
      this.lastPatternTime[key] = timestamp
      patterns.push(pattern)
    }

    // Pattern 1: Liquidity Withdrawal
    if (derivatives.askRate < -0.05 && derivatives.bidRate > -0.02 && canAddPattern('LIQUIDITY_WITHDRAWAL', 'ASK')) {
      addPattern({
        type: 'LIQUIDITY_WITHDRAWAL',
        side: 'ASK',
        strength: Math.min(Math.abs(derivatives.askRate) * 500, 100),
        confidence: 80,
        description: 'Sellers withdrawing liquidity rapidly',
        price: midPrice,
        timestamp
      })
    }

    if (derivatives.bidRate < -0.05 && derivatives.askRate > -0.02 && canAddPattern('LIQUIDITY_WITHDRAWAL', 'BID')) {
      addPattern({
        type: 'LIQUIDITY_WITHDRAWAL',
        side: 'BID',
        strength: Math.min(Math.abs(derivatives.bidRate) * 500, 100),
        confidence: 80,
        description: 'Buyers withdrawing liquidity rapidly',
        price: midPrice,
        timestamp
      })
    }

    // Pattern 2: Liquidity Surge
    if (derivatives.bidRate > 0.1 && Math.abs(derivatives.priceVelocity) < this.config.tickSize && canAddPattern('LIQUIDITY_SURGE', 'BID')) {
      addPattern({
        type: 'LIQUIDITY_SURGE',
        side: 'BID',
        strength: Math.min(derivatives.bidRate * 200, 100),
        confidence: 70,
        description: 'Buy orders surging but price stable',
        price: midPrice,
        timestamp
      })
    }

    if (derivatives.askRate > 0.1 && Math.abs(derivatives.priceVelocity) < this.config.tickSize && canAddPattern('LIQUIDITY_SURGE', 'ASK')) {
      addPattern({
        type: 'LIQUIDITY_SURGE',
        side: 'ASK',
        strength: Math.min(derivatives.askRate * 200, 100),
        confidence: 70,
        description: 'Sell orders surging but price stable',
        price: midPrice,
        timestamp
      })
    }

    // Pattern 3: Accumulation/Distribution
    const recentPatterns = this.patternHistory.getLast(10)
    const bidSurgeCount = recentPatterns.filter(
      p => p.type === 'LIQUIDITY_SURGE' && p.side === 'BID'
    ).length

    if (bidSurgeCount >= 3 && derivatives.priceVelocity < 0) {
      patterns.push({
        type: 'ACCUMULATION',
        side: 'BID',
        strength: 70,
        confidence: 75,
        description: 'Persistent bid liquidity despite falling price',
        price: midPrice,
        timestamp
      })
    }

    // Pattern 4: Market Maker Shift
    if (
      Math.abs(derivatives.bidRate - derivatives.askRate) < 0.05 &&
      Math.abs(derivatives.bidRate) > 0.03 &&
      canAddPattern('MARKET_MAKER_SHIFT', 'BOTH')
    ) {
      addPattern({
        type: 'MARKET_MAKER_SHIFT',
        side: 'BOTH',
        strength: 60,
        confidence: 85,
        description: 'Market maker adjusting quotes symmetrically',
        price: midPrice,
        timestamp
      })
    }

    // Pattern 5: Sweep Preparation
    if (derivatives.askRate < -0.03 && derivatives.bidVelocity > avgLiquidity * 0.05) {
      patterns.push({
        type: 'SWEEP_PREP',
        side: 'ASK',
        strength: 75,
        confidence: 65,
        description: 'Potential sweep preparation detected',
        price: midPrice,
        timestamp
      })
    }

    return patterns
  }

  private generateSignal(
    derivatives: Derivatives,
    patterns: DynamicPattern[],
    orderbook: OrderbookSnapshot
  ): TradingSignal | null {
    // Check cooldown
    const now = Date.now()
    if (now - this.lastSignalTime < this.signalCooldown) {
      return null
    }

    // Calculate signal strength
    let signalStrength = 0
    let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL'
    let reasons: string[] = []

    // Check for strong patterns
    const withdrawalPatterns = patterns.filter(p => p.type === 'LIQUIDITY_WITHDRAWAL')
    const surgePatterns = patterns.filter(p => p.type === 'LIQUIDITY_SURGE')
    const accumPatterns = patterns.filter(p => p.type === 'ACCUMULATION')

    // Long signals
    if (withdrawalPatterns.some(p => p.side === 'ASK' && p.strength > 70)) {
      signalStrength += 40
      direction = 'LONG'
      reasons.push('Strong ask withdrawal')
    }

    if (accumPatterns.length > 0) {
      signalStrength += 30
      direction = 'LONG'
      reasons.push('Accumulation pattern detected')
    }

    // Short signals
    if (
      surgePatterns.some(p => p.side === 'BID' && p.strength > 60) &&
      Math.abs(derivatives.priceVelocity) < this.config.tickSize / 2
    ) {
      signalStrength += 35
      direction = 'SHORT'
      reasons.push('Bid surge without price movement')
    }

    if (withdrawalPatterns.some(p => p.side === 'BID' && p.strength > 70)) {
      signalStrength += 40
      direction = 'SHORT'
      reasons.push('Strong bid withdrawal')
    }

    // Additional factors
    if (Math.abs(derivatives.imbalanceRatio) > 3) {
      signalStrength += 15
      reasons.push(`Extreme imbalance ratio: ${derivatives.imbalanceRatio.toFixed(2)}`)
    }

    // Only generate signal if strong enough
    if (signalStrength < this.minSignalStrength) {
      return null
    }

    const midPrice = this.calculateMidPrice(orderbook)
    const atrInPrice = midPrice * (this.config.atrBps / 10000)

    // Calculate entry, TP, SL based on ATR
    const entryOffset = this.config.tickSize * 2 // 2 ticks inside spread
    const tpDistance = atrInPrice * 0.5 // 0.5 ATR
    const slDistance = atrInPrice * 1.0 // 1.0 ATR

    let entryPrice: number
    let takeProfit: number
    let stopLoss: number

    if (direction === 'LONG') {
      entryPrice = orderbook.bids[0].price + entryOffset
      takeProfit = entryPrice + tpDistance
      stopLoss = entryPrice - slDistance
    } else {
      entryPrice = orderbook.asks[0].price - entryOffset
      takeProfit = entryPrice - tpDistance
      stopLoss = entryPrice + slDistance
    }

    // Determine confidence based on pattern confluence
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'
    if (patterns.length >= 3 && signalStrength > 80) confidence = 'HIGH'
    else if (patterns.length >= 2 && signalStrength > 70) confidence = 'MEDIUM'

    this.lastSignalTime = now

    return {
      timestamp: now,
      direction,
      strength: Math.min(signalStrength, 100),
      entryPrice,
      takeProfit,
      stopLoss,
      reason: reasons.join('; '),
      confidence,
      expectedDuration: 60 + Math.random() * 120 // 1-3 minutes
    }
  }

  private getEmptyDerivatives(): Derivatives {
    return {
      bidVelocity: 0,
      askVelocity: 0,
      bidRate: 0,
      askRate: 0,
      spreadVelocity: 0,
      priceVelocity: 0,
      netFlow: 0,
      imbalanceRatio: 0
    }
  }

  getMarketState(): MarketState {
    const derivatives = this.calculateDerivatives()
    const spreads = this.spreadHistory.toArray()
    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length || 0
    const spreadStd =
      Math.sqrt(spreads.reduce((sum, s) => sum + Math.pow(s - avgSpread, 2), 0) / spreads.length) ||
      0

    // Determine volatility
    const isVolatile =
      spreadStd > avgSpread * 0.3 || Math.abs(derivatives.priceVelocity) > this.config.tickSize * 10

    // Determine trend
    const priceChanges = this.midPriceHistory.getLast(10)
    let trendStrength = 0
    if (priceChanges.length >= 2) {
      const priceChange = priceChanges[priceChanges.length - 1] - priceChanges[0]
      trendStrength = (priceChange / priceChanges[0]) * 10000 // in bps
    }

    // Liquidity score
    const avgBidLiquidity =
      this.bidLiquidityHistory
        .toArray()
        .slice(-5)
        .reduce((a, b) => a + b, 0) / 5 || 0
    const avgAskLiquidity =
      this.askLiquidityHistory
        .toArray()
        .slice(-5)
        .reduce((a, b) => a + b, 0) / 5 || 0
    const totalLiquidity = avgBidLiquidity + avgAskLiquidity
    const liquidityScore = Math.min(totalLiquidity / 100, 100) // Normalize to 0-100

    // Determine regime
    let regime: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET'
    if (isVolatile) {
      regime = 'VOLATILE'
    } else if (Math.abs(trendStrength) > 50) {
      regime = 'TRENDING'
    } else if (spreadStd < avgSpread * 0.1) {
      regime = 'QUIET'
    } else {
      regime = 'RANGING'
    }

    return {
      isVolatile,
      trendStrength,
      liquidityScore,
      regime
    }
  }

  getStats(): {
    avgBidVelocity: number
    avgAskVelocity: number
    avgSpread: number
    velocityImbalance: number
    patternCounts: Record<string, number>
  } {
    const derivatives = this.calculateDerivatives()
    const spreads = this.spreadHistory.toArray()
    const patterns = this.patternHistory.toArray()

    const patternCounts: Record<string, number> = {}
    patterns.forEach(p => {
      patternCounts[p.type] = (patternCounts[p.type] || 0) + 1
    })

    return {
      avgBidVelocity: derivatives.bidVelocity,
      avgAskVelocity: derivatives.askVelocity,
      avgSpread: spreads.reduce((a, b) => a + b, 0) / spreads.length || 0,
      velocityImbalance: derivatives.imbalanceRatio,
      patternCounts
    }
  }

  getCurrentPatterns(): DynamicPattern[] {
    return this.patternHistory.getLast(5)
  }

  getCurrentDerivatives(): Derivatives {
    return this.calculateDerivatives()
  }
  
  getCurrentOrderbook(): OrderbookSnapshot | null {
    const snapshots = this.orderbookHistory.toArray()
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  }
}
