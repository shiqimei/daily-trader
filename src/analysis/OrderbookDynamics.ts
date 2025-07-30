import { CircularBuffer } from '../utils/CircularBuffer';
import {
  OrderbookSnapshot,
  OrderLevel,
  Derivatives,
  TradingSignal,
  DynamicPattern,
  TradingConfig,
  MarketState
} from '../types/orderbook';

export class OrderbookDynamics {
  private readonly orderbookHistory: CircularBuffer<OrderbookSnapshot>;
  private readonly bidLiquidityHistory: CircularBuffer<number>;
  private readonly askLiquidityHistory: CircularBuffer<number>;
  private readonly spreadHistory: CircularBuffer<number>;
  private readonly midPriceHistory: CircularBuffer<number>;
  private readonly patternHistory: CircularBuffer<DynamicPattern>;
  
  private lastSignalTime: number = 0;
  private readonly signalCooldown: number = 3000; // milliseconds
  
  constructor(
    private readonly config: TradingConfig,
    private readonly windowSize: number = 20,
    private readonly depthLevels: number = 5,
    private readonly minSignalStrength: number = 60
  ) {
    this.orderbookHistory = new CircularBuffer(windowSize);
    this.bidLiquidityHistory = new CircularBuffer(windowSize);
    this.askLiquidityHistory = new CircularBuffer(windowSize);
    this.spreadHistory = new CircularBuffer(windowSize);
    this.midPriceHistory = new CircularBuffer(windowSize);
    this.patternHistory = new CircularBuffer(100);
  }
  
  update(orderbook: OrderbookSnapshot): TradingSignal | null {
    // Store orderbook
    this.orderbookHistory.push(orderbook);
    
    // Calculate and store metrics
    const bidLiquidity = this.calculateLiquidity(orderbook.bids, this.depthLevels);
    const askLiquidity = this.calculateLiquidity(orderbook.asks, this.depthLevels);
    const spread = this.calculateSpread(orderbook);
    const midPrice = this.calculateMidPrice(orderbook);
    
    this.bidLiquidityHistory.push(bidLiquidity);
    this.askLiquidityHistory.push(askLiquidity);
    this.spreadHistory.push(spread);
    this.midPriceHistory.push(midPrice);
    
    // Need at least 3 snapshots for derivatives
    if (this.orderbookHistory.length < 3) {
      return null;
    }
    
    // Calculate derivatives
    const derivatives = this.calculateDerivatives();
    
    // Detect patterns
    const patterns = this.detectPatterns(derivatives, orderbook);
    patterns.forEach(p => this.patternHistory.push(p));
    
    // Generate signal if appropriate
    return this.generateSignal(derivatives, patterns, orderbook);
  }
  
  private calculateLiquidity(levels: OrderLevel[], depth: number): number {
    return levels
      .slice(0, depth)
      .reduce((sum, level) => sum + level.size, 0);
  }
  
  private calculateSpread(orderbook: OrderbookSnapshot): number {
    if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return 0;
    }
    return orderbook.asks[0].price - orderbook.bids[0].price;
  }
  
  private calculateMidPrice(orderbook: OrderbookSnapshot): number {
    if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return 0;
    }
    return (orderbook.bids[0].price + orderbook.asks[0].price) / 2;
  }
  
  calculateDerivatives(): Derivatives {
    const bidLiquidity = this.bidLiquidityHistory.toArray();
    const askLiquidity = this.askLiquidityHistory.toArray();
    const spreads = this.spreadHistory.toArray();
    const prices = this.midPriceHistory.toArray();
    const orderbooks = this.orderbookHistory.toArray();
    
    const n = bidLiquidity.length;
    if (n < 3) {
      return this.getEmptyDerivatives();
    }
    
    // Time differences in seconds
    const dt = (orderbooks[n-1].timestamp - orderbooks[n-3].timestamp) / 1000;
    
    // Velocities (first derivatives)
    const bidVelocity = (bidLiquidity[n-1] - bidLiquidity[n-3]) / dt;
    const askVelocity = (askLiquidity[n-1] - askLiquidity[n-3]) / dt;
    const spreadVelocity = (spreads[n-1] - spreads[n-3]) / dt;
    const priceVelocity = (prices[n-1] - prices[n-3]) / dt;
    
    // Relative rates (percentage change per second)
    const bidRate = bidLiquidity[n-2] > 0 ? bidVelocity / bidLiquidity[n-2] : 0;
    const askRate = askLiquidity[n-2] > 0 ? askVelocity / askLiquidity[n-2] : 0;
    
    // Net flow and imbalance
    const netFlow = bidVelocity + askVelocity;
    const imbalanceRatio = askVelocity !== 0 ? bidVelocity / askVelocity : 
                           bidVelocity > 0 ? 999 : -999;
    
    return {
      bidVelocity,
      askVelocity,
      bidRate,
      askRate,
      spreadVelocity,
      priceVelocity,
      netFlow,
      imbalanceRatio
    };
  }
  
  private detectPatterns(derivatives: Derivatives, orderbook: OrderbookSnapshot): DynamicPattern[] {
    const patterns: DynamicPattern[] = [];
    const avgLiquidity = (this.bidLiquidityHistory.toArray().slice(-5).reduce((a, b) => a + b, 0) +
                         this.askLiquidityHistory.toArray().slice(-5).reduce((a, b) => a + b, 0)) / 10;
    
    // Pattern 1: Liquidity Withdrawal
    if (derivatives.askRate < -0.3 && derivatives.bidRate > -0.1) {
      patterns.push({
        type: 'LIQUIDITY_WITHDRAWAL',
        side: 'ASK',
        strength: Math.min(Math.abs(derivatives.askRate) * 100, 100),
        confidence: 80,
        description: 'Sellers withdrawing liquidity rapidly'
      });
    }
    
    if (derivatives.bidRate < -0.3 && derivatives.askRate > -0.1) {
      patterns.push({
        type: 'LIQUIDITY_WITHDRAWAL',
        side: 'BID',
        strength: Math.min(Math.abs(derivatives.bidRate) * 100, 100),
        confidence: 80,
        description: 'Buyers withdrawing liquidity rapidly'
      });
    }
    
    // Pattern 2: Liquidity Surge
    if (derivatives.bidRate > 0.5 && Math.abs(derivatives.priceVelocity) < this.config.tickSize) {
      patterns.push({
        type: 'LIQUIDITY_SURGE',
        side: 'BID',
        strength: Math.min(derivatives.bidRate * 50, 100),
        confidence: 70,
        description: 'Buy orders surging but price stable'
      });
    }
    
    if (derivatives.askRate > 0.5 && Math.abs(derivatives.priceVelocity) < this.config.tickSize) {
      patterns.push({
        type: 'LIQUIDITY_SURGE',
        side: 'ASK',
        strength: Math.min(derivatives.askRate * 50, 100),
        confidence: 70,
        description: 'Sell orders surging but price stable'
      });
    }
    
    // Pattern 3: Accumulation/Distribution
    const recentPatterns = this.patternHistory.getLast(10);
    const bidSurgeCount = recentPatterns.filter(p => 
      p.type === 'LIQUIDITY_SURGE' && p.side === 'BID'
    ).length;
    
    if (bidSurgeCount >= 3 && derivatives.priceVelocity < 0) {
      patterns.push({
        type: 'ACCUMULATION',
        side: 'BID',
        strength: 70,
        confidence: 75,
        description: 'Persistent bid liquidity despite falling price'
      });
    }
    
    // Pattern 4: Market Maker Shift
    if (Math.abs(derivatives.bidRate - derivatives.askRate) < 0.1 &&
        Math.abs(derivatives.bidRate) > 0.2) {
      patterns.push({
        type: 'MARKET_MAKER_SHIFT',
        side: 'BOTH',
        strength: 60,
        confidence: 85,
        description: 'Market maker adjusting quotes symmetrically'
      });
    }
    
    // Pattern 5: Sweep Preparation
    if (derivatives.askRate < -0.2 && derivatives.bidVelocity > avgLiquidity * 0.1) {
      patterns.push({
        type: 'SWEEP_PREP',
        side: 'ASK',
        strength: 75,
        confidence: 65,
        description: 'Potential sweep preparation detected'
      });
    }
    
    return patterns;
  }
  
  private generateSignal(
    derivatives: Derivatives, 
    patterns: DynamicPattern[], 
    orderbook: OrderbookSnapshot
  ): TradingSignal | null {
    // Check cooldown
    const now = Date.now();
    if (now - this.lastSignalTime < this.signalCooldown) {
      return null;
    }
    
    // Calculate signal strength
    let signalStrength = 0;
    let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
    let reasons: string[] = [];
    
    // Check for strong patterns
    const withdrawalPatterns = patterns.filter(p => p.type === 'LIQUIDITY_WITHDRAWAL');
    const surgePatterns = patterns.filter(p => p.type === 'LIQUIDITY_SURGE');
    const accumPatterns = patterns.filter(p => p.type === 'ACCUMULATION');
    
    // Long signals
    if (withdrawalPatterns.some(p => p.side === 'ASK' && p.strength > 70)) {
      signalStrength += 40;
      direction = 'LONG';
      reasons.push('Strong ask withdrawal');
    }
    
    if (accumPatterns.length > 0) {
      signalStrength += 30;
      direction = 'LONG';
      reasons.push('Accumulation pattern detected');
    }
    
    // Short signals
    if (surgePatterns.some(p => p.side === 'BID' && p.strength > 60) && 
        Math.abs(derivatives.priceVelocity) < this.config.tickSize / 2) {
      signalStrength += 35;
      direction = 'SHORT';
      reasons.push('Bid surge without price movement');
    }
    
    if (withdrawalPatterns.some(p => p.side === 'BID' && p.strength > 70)) {
      signalStrength += 40;
      direction = 'SHORT';
      reasons.push('Strong bid withdrawal');
    }
    
    // Additional factors
    if (Math.abs(derivatives.imbalanceRatio) > 3) {
      signalStrength += 15;
      reasons.push(`Extreme imbalance ratio: ${derivatives.imbalanceRatio.toFixed(2)}`);
    }
    
    // Only generate signal if strong enough
    if (signalStrength < this.minSignalStrength) {
      return null;
    }
    
    const midPrice = this.calculateMidPrice(orderbook);
    const atrInPrice = midPrice * (this.config.atrBps / 10000);
    
    // Calculate entry, TP, SL based on ATR
    const entryOffset = this.config.tickSize * 2; // 2 ticks inside spread
    const tpDistance = atrInPrice * 0.5; // 0.5 ATR
    const slDistance = atrInPrice * 1.0; // 1.0 ATR
    
    let entryPrice: number;
    let takeProfit: number;
    let stopLoss: number;
    
    if (direction === 'LONG') {
      entryPrice = orderbook.bids[0].price + entryOffset;
      takeProfit = entryPrice + tpDistance;
      stopLoss = entryPrice - slDistance;
    } else {
      entryPrice = orderbook.asks[0].price - entryOffset;
      takeProfit = entryPrice - tpDistance;
      stopLoss = entryPrice + slDistance;
    }
    
    // Determine confidence based on pattern confluence
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    if (patterns.length >= 3 && signalStrength > 80) confidence = 'HIGH';
    else if (patterns.length >= 2 && signalStrength > 70) confidence = 'MEDIUM';
    
    this.lastSignalTime = now;
    
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
    };
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
    };
  }
  
  getMarketState(): MarketState {
    const derivatives = this.calculateDerivatives();
    const spreads = this.spreadHistory.toArray();
    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length || 0;
    const spreadStd = Math.sqrt(
      spreads.reduce((sum, s) => sum + Math.pow(s - avgSpread, 2), 0) / spreads.length
    ) || 0;
    
    // Determine volatility
    const isVolatile = spreadStd > avgSpread * 0.3 || 
                      Math.abs(derivatives.priceVelocity) > this.config.tickSize * 10;
    
    // Determine trend
    const priceChanges = this.midPriceHistory.getLast(10);
    let trendStrength = 0;
    if (priceChanges.length >= 2) {
      const priceChange = priceChanges[priceChanges.length - 1] - priceChanges[0];
      trendStrength = (priceChange / priceChanges[0]) * 10000; // in bps
    }
    
    // Liquidity score
    const avgBidLiquidity = this.bidLiquidityHistory.toArray().slice(-5).reduce((a, b) => a + b, 0) / 5 || 0;
    const avgAskLiquidity = this.askLiquidityHistory.toArray().slice(-5).reduce((a, b) => a + b, 0) / 5 || 0;
    const totalLiquidity = avgBidLiquidity + avgAskLiquidity;
    const liquidityScore = Math.min(totalLiquidity / 100, 100); // Normalize to 0-100
    
    // Determine regime
    let regime: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET';
    if (isVolatile) {
      regime = 'VOLATILE';
    } else if (Math.abs(trendStrength) > 50) {
      regime = 'TRENDING';
    } else if (spreadStd < avgSpread * 0.1) {
      regime = 'QUIET';
    } else {
      regime = 'RANGING';
    }
    
    return {
      isVolatile,
      trendStrength,
      liquidityScore,
      regime
    };
  }
  
  getStats(): {
    avgBidVelocity: number;
    avgAskVelocity: number;
    avgSpread: number;
    velocityImbalance: number;
    patternCounts: Record<string, number>;
  } {
    const derivatives = this.calculateDerivatives();
    const spreads = this.spreadHistory.toArray();
    const patterns = this.patternHistory.toArray();
    
    const patternCounts: Record<string, number> = {};
    patterns.forEach(p => {
      patternCounts[p.type] = (patternCounts[p.type] || 0) + 1;
    });
    
    return {
      avgBidVelocity: derivatives.bidVelocity,
      avgAskVelocity: derivatives.askVelocity,
      avgSpread: spreads.reduce((a, b) => a + b, 0) / spreads.length || 0,
      velocityImbalance: derivatives.imbalanceRatio,
      patternCounts
    };
  }
  
  getCurrentPatterns(): DynamicPattern[] {
    return this.patternHistory.getLast(5);
  }
  
  getCurrentDerivatives(): Derivatives {
    return this.calculateDerivatives();
  }
}