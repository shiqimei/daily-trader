// Orderbook types
export interface OrderLevel {
  price: number;
  size: number;
}

export interface OrderbookSnapshot {
  timestamp: number;
  bids: OrderLevel[];
  asks: OrderLevel[];
}

export interface Derivatives {
  bidVelocity: number;      // Base currency units/second
  askVelocity: number;      // Base currency units/second
  bidRate: number;          // %/second (relative change rate)
  askRate: number;          // %/second
  spreadVelocity: number;   // Quote currency units/second
  priceVelocity: number;    // Quote currency units/second
  netFlow: number;          // Net liquidity change (base currency)
  imbalanceRatio: number;   // Bid velocity / Ask velocity
}

export interface TradingSignal {
  timestamp: number;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;         // 0-100
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  reason: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  expectedDuration: number; // seconds
}

export interface DynamicPattern {
  type: 'LIQUIDITY_WITHDRAWAL' | 'LIQUIDITY_SURGE' | 'ACCUMULATION' | 
        'DISTRIBUTION' | 'SWEEP_PREP' | 'ICEBERG' | 'MARKET_MAKER_SHIFT';
  side: 'BID' | 'ASK' | 'BOTH';
  strength: number;         // 0-100
  confidence: number;       // 0-100
  description: string;
}

export interface TradingConfig {
  symbol: string;
  tickSize: number;
  minOrderSize: number;
  makerFee: number;         // As decimal (0.0000 for free)
  takerFee: number;         // As decimal (0.0004 for 0.04%)
  atrBps: number;           // ATR in basis points
  targetWinRate: number;    // As decimal (0.75 for 75%)
}

export interface MarketState {
  isVolatile: boolean;
  trendStrength: number;    // -100 to 100 (negative = bearish)
  liquidityScore: number;   // 0-100
  regime: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET';
}