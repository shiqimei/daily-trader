// Compressed TOCHLV format for klines to reduce token usage

export interface CompressedKline {
  t: number;  // timestamp (ms)
  o: string;  // open
  c: string;  // close  
  h: string;  // high
  l: string;  // low
  v: string;  // volume
}

export interface CompressedKlinesResponse {
  s: string;    // symbol
  i: string;    // interval
  n: number;    // count
  k: CompressedKline[];  // klines array
}

export interface CsvKlinesResponse {
  s: string;    // symbol
  i: string;    // interval
  n: number;    // count
  d: string;    // CSV data: "t,o,c,h,l,v\n..."
}


export interface OriginalKline {
  openTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: string;
  quoteVolume: string;
  trades: number;
  takerBuyBaseVolume: string;
  takerBuyQuoteVolume: string;
}

export interface OriginalKlinesResponse {
  symbol: string;
  interval: string;
  count: number;
  klines: OriginalKline[];
}

/**
 * Compress klines response to minimal TOCHLV format
 */
export function compressKlines(original: OriginalKlinesResponse): CompressedKlinesResponse {
  return {
    s: original.symbol,
    i: original.interval,
    n: original.count,
    k: original.klines.map(kline => ({
      t: new Date(kline.openTime).getTime(),
      o: kline.open,
      c: kline.close,
      h: kline.high,
      l: kline.low,
      v: kline.volume
    }))
  };
}

/**
 * Decompress klines back to original format (for compatibility)
 */
export function decompressKlines(compressed: CompressedKlinesResponse): OriginalKlinesResponse {
  return {
    symbol: compressed.s,
    interval: compressed.i,
    count: compressed.n,
    klines: compressed.k.map(k => ({
      openTime: new Date(k.t).toISOString(),
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
      volume: k.v,
      closeTime: new Date(k.t + getIntervalMs(compressed.i) - 1).toISOString(),
      quoteVolume: "0", // Not included in compressed format
      trades: 0, // Not included in compressed format
      takerBuyBaseVolume: "0", // Not included in compressed format
      takerBuyQuoteVolume: "0" // Not included in compressed format
    }))
  };
}

/**
 * Get interval duration in milliseconds
 */
function getIntervalMs(interval: string): number {
  const unit = interval.slice(-1);
  const value = parseInt(interval.slice(0, -1));
  
  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'w': return value * 7 * 24 * 60 * 60 * 1000;
    case 'M': return value * 30 * 24 * 60 * 60 * 1000;
    default: return 15 * 60 * 1000; // Default to 15m
  }
}

/**
 * Compress klines to CSV format for maximum token savings
 */
export function compressKlinesToCsv(original: OriginalKlinesResponse): CsvKlinesResponse {
  // Build CSV with minimal formatting - no headers, just data
  const csvLines = original.klines.map(kline => {
    // Format date as YYYY-MM-DD HH:mm
    const date = new Date(kline.openTime);
    const dateStr = date.toISOString().slice(0, 16).replace('T', ' ');
    return `${dateStr},${kline.open},${kline.close},${kline.high},${kline.low},${kline.volume}`;
  });
  
  return {
    s: original.symbol,
    i: original.interval,
    n: original.count,
    d: csvLines.join('\n')
  };
}

/**
 * Parse CSV klines back to structured format
 */
export function parseCsvKlines(csv: CsvKlinesResponse): CompressedKlinesResponse {
  const lines = csv.d.split('\n');
  const klines = lines.map(line => {
    const [dateStr, o, c, h, l, v] = line.split(',');
    // Parse YYYY-MM-DD HH:mm back to timestamp
    const t = new Date(dateStr.replace(' ', 'T') + ':00.000Z').getTime();
    return {
      t,
      o, c, h, l, v
    };
  });
  
  return {
    s: csv.s,
    i: csv.i,
    n: csv.n,
    k: klines
  };
}

/**
 * Format compressed klines as a concise string for display
 */
export function formatCompressedKlines(compressed: CompressedKlinesResponse): string {
  const lines = [
    `${compressed.s} ${compressed.i} (${compressed.n} candles)`,
    "Time,Open,Close,High,Low,Volume"
  ];
  
  compressed.k.forEach(k => {
    const time = new Date(k.t).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`${time},${k.o},${k.c},${k.h},${k.l},${k.v}`);
  });
  
  return lines.join('\n');
}