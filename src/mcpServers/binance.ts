#!/usr/bin/env -S npx tsx
import { Server } from '@modelcontextprotocol/sdk/server/index'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types'
import crypto from 'crypto'
import dotenv from 'dotenv'
import { compressKlinesToCsv, type OriginalKlinesResponse } from '../utils/klineCompression'

dotenv.config()

type Interval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | '1M'

interface BinanceConfig {
  apiKey: string
  apiSecret: string
  baseUrl: string
}

// Helper function to create signature
function createSignature(queryString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex')
}

// Helper function to round quantity to proper precision
function roundToStepSize(quantity: number, stepSize: number): number {
  const precision = stepSize.toString().split('.')[1]?.length || 0
  const factor = Math.pow(10, precision)
  return Math.floor(quantity * factor) / factor
}

// Helper function to get symbol precision info
async function getSymbolInfo(config: BinanceConfig, symbol: string): Promise<any> {
  const exchangeInfo = await makeRequest(config, '/fapi/v1/exchangeInfo')
  const symbolInfo = exchangeInfo.symbols.find((s: any) => s.symbol === symbol)
  if (!symbolInfo) {
    throw new Error(`Symbol ${symbol} not found`)
  }
  return symbolInfo
}

// Helper function to calculate ATR and return both basis points and quote value
async function calculateAtr(
  config: BinanceConfig,
  symbol: string,
  timeframe: Interval = '15m',
  period: number = 14
): Promise<{ bps: number; quote: number }> {
  // Fetch enough klines to calculate ATR (period + 1 for first TR calculation)
  const limit = period + 1
  const klines = await makeRequest(config, '/fapi/v1/klines', {
    symbol,
    interval: timeframe,
    limit
  })

  if (klines.length < limit) {
    throw new Error(`Not enough data to calculate ATR for ${symbol}`)
  }

  // Calculate True Range for each candle (skip the first one)
  const trueRanges: number[] = []
  for (let i = 1; i < klines.length; i++) {
    const current = klines[i]
    const previous = klines[i - 1]
    
    const high = parseFloat(current[2])
    const low = parseFloat(current[3])
    const prevClose = parseFloat(previous[4])
    
    // True Range = max(high - low, abs(high - prevClose), abs(low - prevClose))
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    )
    trueRanges.push(tr)
  }

  // Calculate ATR as the average of True Ranges
  const atr = trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length
  
  // Get current price for basis points calculation
  const currentPrice = parseFloat(klines[klines.length - 1][4]) // Last close price
  const atrBasisPoints = (atr / currentPrice) * 10000

  return {
    bps: atrBasisPoints,
    quote: atr
  }
}

// Helper function to make API requests
async function makeRequest(
  config: BinanceConfig,
  endpoint: string,
  params: Record<string, any> = {},
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  requireAuth: boolean = false
): Promise<any> {
  let url = `${config.baseUrl}${endpoint}`
  let body: string | undefined

  if (requireAuth) {
    params.timestamp = Date.now()
    params.recvWindow = 5000
  }

  // Filter out undefined values
  const filteredParams = Object.entries(params)
    .filter(([_, value]) => value !== undefined)
    .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})

  const queryString = Object.entries(filteredParams)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')

  if (requireAuth) {
    const signature = createSignature(queryString, config.apiSecret)
    const signedQuery = `${queryString}&signature=${signature}`

    if (method === 'GET' || method === 'DELETE') {
      url += `?${signedQuery}`
    } else {
      body = signedQuery
    }
  } else if (method === 'GET' && queryString) {
    url += `?${queryString}`
  } else if (method !== 'GET') {
    body = queryString
  }

  const headers: Record<string, string> = {
    'X-MBX-APIKEY': config.apiKey,
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  const response = await fetch(url, {
    method,
    headers,
    body
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Binance API error: ${response.status} - ${errorText}`)
  }

  return response.json()
}

const binanceTools: Tool[] = [
  // Common Utils
  {
    name: 'calculate_position_size',
    description:
      'Calculate position size in base asset from USDT amount, considering current leverage and price',
    inputSchema: {
      type: 'object',
      properties: {
        usdtAmount: { type: 'number', description: 'Amount in USDT to use as margin' },
        symbol: { type: 'string', description: 'Trading pair symbol (e.g., BTCUSDT)' }
      },
      required: ['usdtAmount', 'symbol']
    }
  },
  {
    name: 'get_server_time',
    description: 'Get Binance server time',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // Market Data
  {
    name: 'get_klines',
    description: 'Get candlestick data for a symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        interval: {
          type: 'string',
          enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'],
          description: 'Kline interval'
        },
        limit: {
          type: 'number',
          description:
            'Number of klines to return (min: 1d-10, 4h-20, 30m-50, 15m-50, 5m-50; max 1500)',
          default: 100
        }
      },
      required: ['symbol', 'interval']
    }
  },
  {
    name: 'get_klines_all_intervals',
    description: 'Get candlestick data for all standard intervals',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        limit: { type: 'number', description: 'Number of klines per interval', default: 20 }
      },
      required: ['symbol']
    }
  },
  {
    name: 'get_orderbook',
    description: 'Get order book depth for a symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        limit: {
          type: 'number',
          description: 'Depth limit (5, 10, 20, 50, 100, 500, 1000)',
          default: 20
        }
      },
      required: ['symbol']
    }
  },
  {
    name: 'get_ticker_24hr',
    description:
      'Get 24hr ticker statistics including last price, high, low, volume, and price change percentage',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'get_top_symbols',
    description:
      'Get low-liquidity USDC pairs with orderbook gaps, filtered by 5-minute ATR and sorted by ATR ascending',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of top symbols to return', default: 10 },
        minAtrBps: {
          type: 'number',
          description: 'Minimum 5-minute ATR in basis points',
          default: 5
        },
        maxAtrBps: {
          type: 'number',
          description: 'Maximum 5-minute ATR in basis points',
          default: 40
        }
      }
    }
  },
  // Futures Specific Data
  {
    name: 'get_funding_rate',
    description: 'Get current funding rate for a perpetual futures symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'get_funding_history',
    description: 'Get funding rate history',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        limit: { type: 'number', description: 'Number of records', default: 100 }
      },
      required: ['symbol']
    }
  },
  {
    name: 'get_mark_price',
    description: 'Get mark price and funding rate',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'get_exchange_info',
    description: 'Get exchange trading rules and symbol information',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol (optional)' }
      }
    }
  },
  // Account Data
  {
    name: 'get_account',
    description: 'Get current account information including balances and positions',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_positions',
    description: 'Get all open positions with unrealized and realized PnL',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_income_history',
    description: 'Get income history including realized PnL, funding fees, and commissions',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol (optional)' },
        incomeType: {
          type: 'string',
          enum: [
            'TRANSFER',
            'WELCOME_BONUS',
            'REALIZED_PNL',
            'FUNDING_FEE',
            'COMMISSION',
            'INSURANCE_CLEAR'
          ],
          description: 'Income type filter (optional)'
        },
        startTime: { type: 'number', description: 'Start time in milliseconds (optional)' },
        endTime: { type: 'number', description: 'End time in milliseconds (optional)' },
        limit: { type: 'number', description: 'Number of records (max 1000)', default: 100 }
      }
    }
  },
  {
    name: 'get_open_orders',
    description: 'Get all open orders',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol (optional)' }
      }
    }
  },
  {
    name: 'create_listen_key',
    description: 'Create a listen key for user data stream',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'ping_listen_key',
    description: 'Keep-alive a listen key',
    inputSchema: {
      type: 'object',
      properties: {
        listenKey: { type: 'string', description: 'The listen key to keep alive' }
      },
      required: ['listenKey']
    }
  },
  {
    name: 'close_listen_key',
    description: 'Close a listen key',
    inputSchema: {
      type: 'object',
      properties: {
        listenKey: { type: 'string', description: 'The listen key to close' }
      },
      required: ['listenKey']
    }
  },
  {
    name: 'get_trades',
    description: 'Get recent trades',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        limit: { type: 'number', description: 'Number of trades', default: 50 }
      },
      required: ['symbol']
    }
  },
  // Leverage Management
  {
    name: 'get_current_leverage',
    description: 'Get current leverage setting for a symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'set_leverage',
    description: 'Set leverage for a symbol (1-125x depending on symbol)',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        leverage: { type: 'number', description: 'Leverage value (1-125)' }
      },
      required: ['symbol', 'leverage']
    }
  },
  // Order Management
  {
    name: 'place_order',
    description: 'Place a generic order (buy/sell, market/limit)',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        side: { type: 'string', description: 'Order side', enum: ['BUY', 'SELL'] },
        type: { type: 'string', description: 'Order type', enum: ['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET'] },
        quantity: { type: 'number', description: 'Order quantity' },
        price: { type: 'number', description: 'Limit price (required for LIMIT orders)' },
        stopPrice: { type: 'number', description: 'Stop price (required for STOP orders)' },
        timeInForce: {
          type: 'string',
          description: 'Time in force',
          enum: ['GTC', 'IOC', 'FOK', 'GTX']
        },
        reduceOnly: { type: 'boolean', description: 'Reduce only order' }
      },
      required: ['symbol', 'side', 'type', 'quantity']
    }
  },
  // Position Management
  {
    name: 'open_long',
    description: 'Open a long position (market or limit order)',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        quantity: { type: 'number', description: 'Position size in base asset' },
        price: {
          type: 'number',
          description: 'Limit price (optional, market order if not provided)'
        },
        timeInForce: {
          type: 'string',
          description: 'Time in force (GTC, IOC, FOK, GTX/Post-Only)',
          enum: ['GTC', 'IOC', 'FOK', 'GTX']
        }
      },
      required: ['symbol', 'quantity']
    }
  },
  {
    name: 'open_short',
    description: 'Open a short position (market or limit order)',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        quantity: { type: 'number', description: 'Position size in base asset' },
        price: {
          type: 'number',
          description: 'Limit price (optional, market order if not provided)'
        },
        timeInForce: {
          type: 'string',
          description: 'Time in force (GTC, IOC, FOK, GTX/Post-Only)',
          enum: ['GTC', 'IOC', 'FOK', 'GTX']
        }
      },
      required: ['symbol', 'quantity']
    }
  },
  {
    name: 'close_position',
    description: 'Close position at market price',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        percentage: { type: 'number', description: 'Percentage to close (1-100)', default: 100 }
      },
      required: ['symbol']
    }
  },
  {
    name: 'close_position_limit',
    description: 'Close position with limit order',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        price: { type: 'number', description: 'Limit price' },
        percentage: { type: 'number', description: 'Percentage to close (1-100)', default: 100 }
      },
      required: ['symbol', 'price']
    }
  },
  {
    name: 'reverse_position',
    description: 'Reverse current position (long to short or vice versa)',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'increase_position',
    description: 'Increase existing position size',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        quantity: { type: 'number', description: 'Additional quantity' },
        price: { type: 'number', description: 'Limit price (optional)' }
      },
      required: ['symbol', 'quantity']
    }
  },
  {
    name: 'reduce_position',
    description: 'Reduce position by percentage',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        percentage: { type: 'number', description: 'Percentage to reduce (1-100)' },
        price: { type: 'number', description: 'Limit price (optional)' }
      },
      required: ['symbol', 'percentage']
    }
  },
  {
    name: 'set_stop_loss',
    description: 'Set stop loss order',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        triggerPrice: { type: 'number', description: 'Stop trigger price' },
        closePercentage: {
          type: 'number',
          description: 'Percentage to close (1-100)',
          default: 100
        }
      },
      required: ['symbol', 'triggerPrice']
    }
  },
  {
    name: 'set_take_profit',
    description: 'Set take profit order',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        triggerPrice: { type: 'number', description: 'Take profit trigger price' },
        closePercentage: {
          type: 'number',
          description: 'Percentage to close (1-100)',
          default: 100
        }
      },
      required: ['symbol', 'triggerPrice']
    }
  },
  {
    name: 'clear_stops',
    description: 'Cancel all stop orders for a symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'get_order',
    description: 'Get order status',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        orderId: { type: 'string', description: 'Order ID to query' }
      },
      required: ['symbol', 'orderId']
    }
  },
  {
    name: 'cancel_order',
    description: 'Cancel a specific order',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        orderId: { type: 'string', description: 'Order ID to cancel' }
      },
      required: ['symbol', 'orderId']
    }
  },
  {
    name: 'cancel_all_orders',
    description: 'Cancel all open orders',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading pair symbol (optional, cancels all if not provided)'
        }
      }
    }
  },
  // Order History
  {
    name: 'get_order_history',
    description: 'Get order history',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol (optional)' },
        limit: { type: 'number', description: 'Number of orders', default: 50 }
      }
    }
  },
  // Position History
  {
    name: 'get_position_history',
    description: 'Get historical closed and partially closed positions with PnL details',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Trading pair symbols (default: ["BTCUSDC", "ETHUSDC"])'
        },
        last_days: { type: 'number', description: 'Number of days to look back', default: 7 },
        limit: { type: 'number', description: 'Number of positions to return (max: 5)', default: 5 }
      }
    }
  }
]

const server = new Server(
  {
    name: 'binance-futures-server',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
)

function getConfig(): BinanceConfig {
  const apiKey = process.env.BINANCE_FUTURES_API_KEY
  const apiSecret = process.env.BINANCE_FUTURES_API_SECRET
  const isTestnet = process.env.BINANCE_TESTNET === 'true'

  if (!apiKey || !apiSecret) {
    throw new Error(
      'BINANCE_FUTURES_API_KEY and BINANCE_FUTURES_API_SECRET environment variables are required'
    )
  }

  return {
    apiKey,
    apiSecret,
    baseUrl: isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com'
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: binanceTools
  }
})

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params
  const config = getConfig()

  try {
    switch (name) {
      // Common Utils
      case 'calculate_position_size': {
        const { usdtAmount, symbol } = args as { usdtAmount: number; symbol: string }
        const ticker = await makeRequest(config, '/fapi/v1/ticker/24hr', { symbol })
        const price = parseFloat(ticker.lastPrice)

        // Get account info to check current leverage for the symbol
        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find((p: any) => p.symbol === symbol)
        const leverage = position ? parseFloat(position.leverage) : 1

        // Get symbol info for precision
        const symbolInfo = await getSymbolInfo(config, symbol)
        const stepSize = parseFloat(
          symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize || '0.00001'
        )

        // Calculate position size considering leverage
        // With leverage, the actual capital required = (quantity * price) / leverage
        // So for a given USDT amount: quantity = (usdtAmount * leverage) / price
        const quantity = (usdtAmount * leverage) / price
        const roundedQuantity = roundToStepSize(quantity, stepSize)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  usdtAmount,
                  symbol,
                  currentPrice: price,
                  leverage,
                  positionSize: roundedQuantity,
                  notionalValue: roundedQuantity * price,
                  requiredMargin: (roundedQuantity * price) / leverage,
                  stepSize
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_server_time': {
        const result = await makeRequest(config, '/fapi/v1/time')
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  serverTime: new Date(result.serverTime).toISOString(),
                  serverTimeMs: result.serverTime,
                  localTime: new Date().toISOString()
                },
                null,
                2
              )
            }
          ]
        }
      }

      // Market Data
      case 'get_klines': {
        const {
          symbol,
          interval,
          limit = 100
        } = args as { symbol: string; interval: Interval; limit?: number }
        const klines = await makeRequest(config, '/fapi/v1/klines', { symbol, interval, limit })

        const originalFormat: OriginalKlinesResponse = {
          symbol,
          interval,
          count: klines.length,
          klines: klines.map((k: any[]) => ({
            openTime: new Date(k[0]).toISOString(),
            open: k[1],
            high: k[2],
            low: k[3],
            close: k[4],
            volume: k[5],
            closeTime: new Date(k[6]).toISOString(),
            quoteVolume: k[7],
            trades: k[8],
            takerBuyBaseVolume: k[9],
            takerBuyQuoteVolume: k[10]
          }))
        }

        const csvCompressed = compressKlinesToCsv(originalFormat)

        // Calculate ATR for the requested interval
        const atr = await calculateAtr(config, symbol, interval)

        // Add ATR values to the response
        const responseWithAtr = {
          s: csvCompressed.s,
          i: csvCompressed.i,
          atr_bps: Math.round(atr.bps),
          atr_quote: parseFloat(atr.quote.toFixed(4)),
          d: csvCompressed.d
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responseWithAtr, null, 2)
            }
          ]
        }
      }

      case 'get_klines_all_intervals': {
        const { symbol, limit = 20 } = args as { symbol: string; limit?: number }
        const intervals: Interval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
        const results: any = {}

        for (const interval of intervals) {
          const klines = await makeRequest(config, '/fapi/v1/klines', { symbol, interval, limit })
          // Compress each interval's klines
          const originalFormat: OriginalKlinesResponse = {
            symbol,
            interval,
            count: klines.length,
            klines: klines.map((k: any[]) => ({
              openTime: new Date(k[0]).toISOString(),
              open: k[1],
              high: k[2],
              low: k[3],
              close: k[4],
              volume: k[5],
              closeTime: new Date(k[6]).toISOString(),
              quoteVolume: k[7],
              trades: k[8],
              takerBuyBaseVolume: k[9],
              takerBuyQuoteVolume: k[10]
            }))
          }
          const csvCompressed = compressKlinesToCsv(originalFormat)
          
          // Calculate ATR for this interval
          const atr = await calculateAtr(config, symbol, interval)
          
          // Store CSV data and both ATR values
          results[interval] = {
            atr_bps: Math.round(atr.bps),
            atr_quote: parseFloat(atr.quote.toFixed(4)),
            d: csvCompressed.d
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  s: symbol,
                  i: results
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_orderbook': {
        const { symbol, limit = 20 } = args as { symbol: string; limit?: number }
        const orderbook = await makeRequest(config, '/fapi/v1/depth', { symbol, limit })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol,
                  lastUpdateId: orderbook.lastUpdateId,
                  bids: orderbook.bids.slice(0, 10),
                  asks: orderbook.asks.slice(0, 10),
                  bidAskSpread:
                    orderbook.asks.length > 0 && orderbook.bids.length > 0
                      ? parseFloat(orderbook.asks[0][0]) - parseFloat(orderbook.bids[0][0])
                      : 0
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_ticker_24hr': {
        const { symbol } = args as { symbol: string }
        const ticker = await makeRequest(config, '/fapi/v1/ticker/24hr', { symbol })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol: ticker.symbol,
                  priceChange: ticker.priceChange,
                  priceChangePercent: ticker.priceChangePercent,
                  lastPrice: ticker.lastPrice,
                  highPrice: ticker.highPrice,
                  lowPrice: ticker.lowPrice,
                  volume: ticker.volume,
                  quoteVolume: ticker.quoteVolume,
                  openPrice: ticker.openPrice,
                  openTime: new Date(ticker.openTime).toISOString(),
                  closeTime: new Date(ticker.closeTime).toISOString()
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_top_symbols': {
        const {
          limit = 10,
          minAtrBps = 5,
          maxAtrBps = 40
        } = args as {
          limit?: number
          minAtrBps?: number
          maxAtrBps?: number
        }

        // Get 24hr tickers first
        const tickers = await makeRequest(config, '/fapi/v1/ticker/24hr')

        // Pre-filter USDC pairs with minimum volume
        const usdcPairs = tickers
          .filter((ticker: any) => {
            return ticker.symbol.endsWith('USDC') && parseFloat(ticker.quoteVolume) > 1000000
          })

        // Calculate ATR and check orderbook gaps for each symbol
        const pairsWithAtrAndGap = await Promise.all(
          usdcPairs.map(async (ticker: any) => {
            try {
              // Calculate 5m ATR
              const atr5m = await calculateAtr(config, ticker.symbol, '5m')
              const atrBps5m = Math.round(atr5m.bps)

              // Check if ATR is within range
              if (atrBps5m >= minAtrBps && atrBps5m <= maxAtrBps) {
                // Get orderbook to check for gaps
                const orderbook = await makeRequest(config, '/fapi/v1/depth', { 
                  symbol: ticker.symbol, 
                  limit: 5 
                })
                
                // Get symbol info for price precision
                const symbolInfo = await getSymbolInfo(config, ticker.symbol)
                const pricePrecision = symbolInfo.pricePrecision || 2
                const tickSize = parseFloat(
                  symbolInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER')?.tickSize || '0.01'
                )
                
                if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
                  const bestBid = parseFloat(orderbook.bids[0][0])
                  const bestAsk = parseFloat(orderbook.asks[0][0])
                  const spread = bestAsk - bestBid
                  const spreadTicks = Math.round(spread / tickSize)
                  
                  // Only include if spread is more than 1 tick size (has gap)
                  if (spreadTicks > 1) {
                    return {
                      symbol: ticker.symbol,
                      volume: ticker.volume,
                      quote_volume: ticker.quoteVolume,
                      price_change_percent: ticker.priceChangePercent,
                      last_price: ticker.lastPrice,
                      atr_bps_5m: atrBps5m,
                      atr_quote_5m: parseFloat(atr5m.quote.toFixed(4)),
                      best_bid: bestBid.toFixed(pricePrecision),
                      best_ask: bestAsk.toFixed(pricePrecision),
                      spread: spread.toFixed(pricePrecision),
                      spread_ticks: spreadTicks,
                      tick_size: tickSize
                    }
                  }
                }
              }
              return null
            } catch (error) {
              console.error(`Failed to process ${ticker.symbol}:`, error)
              return null
            }
          })
        )

        // Filter out nulls and sort by atr_bps_5m ascending
        const filteredPairs = pairsWithAtrAndGap
          .filter(pair => pair !== null)
          .sort((a: any, b: any) => a.atr_bps_5m - b.atr_bps_5m)
          .slice(0, limit)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: filteredPairs.length,
                  symbols: filteredPairs
                },
                null,
                2
              )
            }
          ]
        }
      }

      // Futures Specific Data
      case 'get_funding_rate': {
        const { symbol } = args as { symbol: string }
        const result = await makeRequest(config, '/fapi/v1/fundingRate', { symbol, limit: 1 })
        const current = result[0] || {}

        // Also get mark price for next funding time
        const markPrice = await makeRequest(config, '/fapi/v1/premiumIndex', { symbol })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol: current.symbol,
                  fundingRate: current.fundingRate,
                  fundingTime: current.fundingTime
                    ? new Date(current.fundingTime).toISOString()
                    : null,
                  nextFundingTime: markPrice.nextFundingTime
                    ? new Date(markPrice.nextFundingTime).toISOString()
                    : null,
                  markPrice: markPrice.markPrice,
                  indexPrice: markPrice.indexPrice
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_funding_history': {
        const { symbol, limit = 100 } = args as { symbol: string; limit?: number }
        const history = await makeRequest(config, '/fapi/v1/fundingRate', { symbol, limit })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol,
                  count: history.length,
                  history: history.map((h: any) => ({
                    fundingTime: new Date(h.fundingTime).toISOString(),
                    fundingRate: h.fundingRate
                  }))
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_mark_price': {
        const { symbol } = args as { symbol: string }
        const markPrice = await makeRequest(config, '/fapi/v1/premiumIndex', { symbol })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol: markPrice.symbol,
                  markPrice: markPrice.markPrice,
                  indexPrice: markPrice.indexPrice,
                  fundingRate: markPrice.lastFundingRate,
                  nextFundingTime: new Date(markPrice.nextFundingTime).toISOString(),
                  time: new Date(markPrice.time).toISOString()
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_exchange_info': {
        const { symbol } = args as { symbol?: string }
        const exchangeInfo = await makeRequest(config, '/fapi/v1/exchangeInfo')

        if (symbol) {
          const symbolInfo = exchangeInfo.symbols.find((s: any) => s.symbol === symbol)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(symbolInfo || { error: `Symbol ${symbol} not found` }, null, 2)
              }
            ]
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  timezone: exchangeInfo.timezone,
                  serverTime: new Date(exchangeInfo.serverTime).toISOString(),
                  rateLimits: exchangeInfo.rateLimits,
                  totalSymbols: exchangeInfo.symbols.length,
                  symbols: exchangeInfo.symbols.slice(0, 10) // Show first 10 symbols
                },
                null,
                2
              )
            }
          ]
        }
      }

      // Account Data
      case 'get_account': {
        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  totalWalletBalance: account.totalWalletBalance,
                  totalUnrealizedProfit: account.totalUnrealizedProfit,
                  totalMarginBalance: account.totalMarginBalance,
                  availableBalance: account.availableBalance,
                  totalPositionInitialMargin: account.totalPositionInitialMargin,
                  totalOpenOrderInitialMargin: account.totalOpenOrderInitialMargin,
                  totalCrossUnPnl: account.totalCrossUnPnl,
                  totalCrossWalletBalance: account.totalCrossWalletBalance,
                  updateTime: new Date(account.updateTime).toISOString(),
                  positions: account.positions.filter((p: any) => parseFloat(p.positionAmt) !== 0),
                  assets: account.assets.filter((a: any) => parseFloat(a.walletBalance) > 0)
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_positions': {
        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const activePositions = account.positions.filter(
          (p: any) => parseFloat(p.positionAmt) !== 0
        )

        // Fetch realized PnL for each active position from income history
        const positionsWithRealizedPnl = await Promise.all(
          activePositions.map(async (position: any) => {
            try {
              // First, try to find position opening time from order history
              // Get all orders for this symbol to find the position opening order
              const allOrders = await makeRequest(
                config,
                '/fapi/v1/allOrders',
                {
                  symbol: position.symbol,
                  limit: 500
                },
                'GET',
                true
              )

              // Sort orders by time descending
              const sortedOrders = allOrders.sort((a: any, b: any) => b.time - a.time)

              // Find the most recent position-opening order (when position was at 0)
              let positionStartTime = Date.now() - 30 * 24 * 60 * 60 * 1000 // Default 30 days ago

              // Look for the order that opened the current position
              for (let i = 0; i < sortedOrders.length; i++) {
                const order = sortedOrders[i]
                if (order.status === 'FILLED' && order.type === 'MARKET') {
                  // This could be our position opening order
                  // For now, use the most recent filled market order as position start
                  positionStartTime = order.time
                  break
                }
              }

              // Get all income types for accurate PnL calculation
              const incomeHistory = await makeRequest(
                config,
                '/fapi/v1/income',
                {
                  symbol: position.symbol,
                  startTime: positionStartTime - 30 * 1000,
                  endTime: Date.now(),
                  limit: 1000
                },
                'GET',
                true
              )

              // Calculate realized PnL: sum(realized_pnl) - sum(funding_fee) - sum(commission)
              let realizedPnlSum = 0
              let fundingFeeSum = 0
              let commissionSum = 0

              incomeHistory.forEach((income: any) => {
                const amount = parseFloat(income.income || '0')
                switch (income.incomeType) {
                  case 'REALIZED_PNL':
                    realizedPnlSum += amount
                    break
                  case 'FUNDING_FEE':
                    fundingFeeSum += amount
                    break
                  case 'COMMISSION':
                    commissionSum += amount
                    break
                }
              })

              // Net realized PnL = realized PnL + funding fees (negative) + commissions (negaitve)
              const netRealizedPnl = realizedPnlSum + fundingFeeSum + commissionSum

              return {
                symbol: position.symbol,
                side: parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT',
                positionAmt: position.positionAmt,
                entryPrice: position.entryPrice,
                markPrice: position.markPrice,
                unrealizedPnl: position.unrealizedProfit,
                realizedPnl: realizedPnlSum,
                netRealizedPnl: netRealizedPnl.toFixed(8),
                commissionFee: commissionSum,
                fundingFee: fundingFeeSum,
                isolatedWallet: position.isolatedWallet,
                notional: position.notional,
                leverage: position.leverage,
                marginType: position.marginType,
                liquidationPrice: position.liquidationPrice,
                updateTime: new Date(position.updateTime).toISOString()
              }
            } catch (error) {
              return {
                symbol: position.symbol,
                side: parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT',
                positionAmt: position.positionAmt,
                entryPrice: position.entryPrice,
                markPrice: position.markPrice,
                unrealizedProfit: position.unrealizedProfit,
                realizedPnl: '0',
                isolatedWallet: position.isolatedWallet,
                notional: position.notional,
                leverage: position.leverage,
                marginType: position.marginType,
                liquidationPrice: position.liquidationPrice,
                updateTime: new Date(position.updateTime).toISOString()
              }
            }
          })
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: positionsWithRealizedPnl.length,
                  positions: positionsWithRealizedPnl
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_income_history': {
        const {
          symbol,
          incomeType,
          startTime,
          endTime,
          limit = 100
        } = args as {
          symbol?: string
          incomeType?: string
          startTime?: number
          endTime?: number
          limit?: number
        }

        const params: any = { limit }
        if (symbol) params.symbol = symbol
        if (incomeType) params.incomeType = incomeType
        if (startTime) params.startTime = startTime
        if (endTime) params.endTime = endTime

        // If no time range specified, default to last 7 days
        if (!startTime && !endTime) {
          params.endTime = Date.now()
          params.startTime = params.endTime - 7 * 24 * 60 * 60 * 1000
        }

        const incomeHistory = await makeRequest(config, '/fapi/v1/income', params, 'GET', true)

        // Sort by time descending (latest first)
        const sortedHistory = incomeHistory.sort((a: any, b: any) => b.time - a.time)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: sortedHistory.length,
                  totalIncome: sortedHistory
                    .reduce(
                      (total: number, income: any) => total + parseFloat(income.income || '0'),
                      0
                    )
                    .toFixed(8),
                  incomeHistory: sortedHistory.map((income: any) => ({
                    symbol: income.symbol,
                    incomeType: income.incomeType,
                    income: income.income,
                    asset: income.asset,
                    info: income.info,
                    time: new Date(income.time).toISOString(),
                    tranId: income.tranId,
                    tradeId: income.tradeId
                  }))
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_open_orders': {
        const { symbol } = args as { symbol?: string }
        const params: any = {}
        if (symbol) params.symbol = symbol

        const orders = await makeRequest(config, '/fapi/v1/openOrders', params, 'GET', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: orders.length,
                  orders: orders.map((o: any) => ({
                    symbol: o.symbol,
                    orderId: o.orderId,
                    clientOrderId: o.clientOrderId,
                    type: o.type,
                    side: o.side,
                    price: o.price,
                    origQty: o.origQty,
                    executedQty: o.executedQty,
                    status: o.status,
                    timeInForce: o.timeInForce,
                    time: new Date(o.time).toISOString(),
                    updateTime: new Date(o.updateTime).toISOString()
                  }))
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'create_listen_key': {
        const result = await makeRequest(config, '/fapi/v1/listenKey', {}, 'POST', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        }
      }

      case 'ping_listen_key': {
        const { listenKey } = args as { listenKey: string }
        await makeRequest(config, '/fapi/v1/listenKey', { listenKey }, 'PUT', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'ok', message: 'Listen key renewed' }, null, 2)
            }
          ]
        }
      }

      case 'close_listen_key': {
        const { listenKey } = args as { listenKey: string }
        await makeRequest(config, '/fapi/v1/listenKey', { listenKey }, 'DELETE', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'ok', message: 'Listen key closed' }, null, 2)
            }
          ]
        }
      }

      case 'get_trades': {
        const { symbol, limit = 50 } = args as { symbol: string; limit?: number }
        const trades = await makeRequest(
          config,
          '/fapi/v1/userTrades',
          { symbol, limit },
          'GET',
          true
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol,
                  count: trades.length,
                  trades: trades.map((t: any) => ({
                    time: new Date(t.time).toISOString(),
                    symbol: t.symbol,
                    id: t.id,
                    orderId: t.orderId,
                    side: t.side,
                    price: t.price,
                    qty: t.qty,
                    realizedPnl: t.realizedPnl,
                    commission: t.commission,
                    commissionAsset: t.commissionAsset,
                    buyer: t.buyer,
                    maker: t.maker
                  }))
                },
                null,
                2
              )
            }
          ]
        }
      }

      // Leverage Management
      case 'get_current_leverage': {
        const { symbol } = args as { symbol: string }
        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find((p: any) => p.symbol === symbol)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol,
                  leverage: position?.leverage || 'No position found',
                  marginType: position?.marginType || 'N/A'
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'set_leverage': {
        const { symbol, leverage } = args as { symbol: string; leverage: number }
        if (leverage < 1 || leverage > 125) {
          throw new Error('Leverage must be between 1 and 125')
        }

        const result = await makeRequest(
          config,
          '/fapi/v1/leverage',
          { symbol, leverage },
          'POST',
          true
        )
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol: result.symbol,
                  leverage: result.leverage,
                  maxNotionalValue: result.maxNotionalValue,
                  success: true
                },
                null,
                2
              )
            }
          ]
        }
      }

      // Order Management
      case 'place_order': {
        const { symbol, side, type, quantity, price, stopPrice, timeInForce, reduceOnly } = args as {
          symbol: string
          side: string
          type: string
          quantity: number
          price?: number
          stopPrice?: number
          timeInForce?: string
          reduceOnly?: boolean
        }

        const params: any = {
          symbol,
          side,
          type,
          quantity
        }

        if (type === 'LIMIT' && price) {
          params.price = price
          params.timeInForce = timeInForce || 'GTC'
        }

        if ((type === 'STOP' || type === 'STOP_MARKET') && stopPrice) {
          params.stopPrice = stopPrice
        }

        if (reduceOnly) {
          params.reduceOnly = true
        }

        const order = await makeRequest(config, '/fapi/v1/order', params, 'POST', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(order, null, 2)
            }
          ]
        }
      }

      // Position Management
      case 'open_long': {
        const { symbol, quantity, price, timeInForce } = args as {
          symbol: string
          quantity: number
          price?: number
          timeInForce?: string
        }
        const params: any = {
          symbol,
          side: 'BUY',
          quantity,
          type: price ? 'LIMIT' : 'MARKET'
        }
        if (price) {
          params.price = price
          params.timeInForce = timeInForce || 'GTC'
        }

        const order = await makeRequest(config, '/fapi/v1/order', params, 'POST', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'OPEN_LONG',
                  symbol,
                  quantity,
                  orderType: order.type,
                  price: order.price,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    executedQty: order.executedQty,
                    avgPrice: order.avgPrice || order.price,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'open_short': {
        const { symbol, quantity, price, timeInForce } = args as {
          symbol: string
          quantity: number
          price?: number
          timeInForce?: string
        }
        const params: any = {
          symbol,
          side: 'SELL',
          quantity,
          type: price ? 'LIMIT' : 'MARKET'
        }
        if (price) {
          params.price = price
          params.timeInForce = timeInForce || 'GTC'
        }

        const order = await makeRequest(config, '/fapi/v1/order', params, 'POST', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'OPEN_SHORT',
                  symbol,
                  quantity,
                  orderType: order.type,
                  price: order.price,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    executedQty: order.executedQty,
                    avgPrice: order.avgPrice || order.price,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'close_position': {
        const { symbol, percentage = 100 } = args as { symbol: string; percentage?: number }
        if (percentage < 1 || percentage > 100) {
          throw new Error('Percentage must be between 1 and 100')
        }

        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find(
          (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
        )

        if (!position) {
          throw new Error(`No open position found for ${symbol}`)
        }

        const positionAmt = parseFloat(position.positionAmt)

        // Get symbol info for precision
        const symbolInfo = await getSymbolInfo(config, symbol)
        const stepSize = parseFloat(
          symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize || '0.00001'
        )

        const closeQty = roundToStepSize(Math.abs(positionAmt * (percentage / 100)), stepSize)
        const side = positionAmt > 0 ? 'SELL' : 'BUY'

        const order = await makeRequest(
          config,
          '/fapi/v1/order',
          {
            symbol,
            side,
            quantity: closeQty,
            type: 'MARKET',
            reduceOnly: true
          },
          'POST',
          true
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'CLOSE_POSITION',
                  symbol,
                  percentage,
                  closeQty,
                  side,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    executedQty: order.executedQty,
                    avgPrice: order.avgPrice,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'close_position_limit': {
        const {
          symbol,
          price,
          percentage = 100
        } = args as { symbol: string; price: number; percentage?: number }
        if (percentage < 1 || percentage > 100) {
          throw new Error('Percentage must be between 1 and 100')
        }

        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find(
          (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
        )

        if (!position) {
          throw new Error(`No open position found for ${symbol}`)
        }

        const positionAmt = parseFloat(position.positionAmt)

        // Get symbol info for precision
        const symbolInfo = await getSymbolInfo(config, symbol)
        const stepSize = parseFloat(
          symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize || '0.00001'
        )

        const closeQty = roundToStepSize(Math.abs(positionAmt * (percentage / 100)), stepSize)
        const side = positionAmt > 0 ? 'SELL' : 'BUY'

        const order = await makeRequest(
          config,
          '/fapi/v1/order',
          {
            symbol,
            side,
            quantity: closeQty,
            type: 'LIMIT',
            timeInForce: 'GTC',
            price,
            reduceOnly: true
          },
          'POST',
          true
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'CLOSE_POSITION_LIMIT',
                  symbol,
                  price,
                  percentage,
                  closeQty,
                  side,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    price: order.price,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'reverse_position': {
        const { symbol } = args as { symbol: string }
        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find(
          (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
        )

        if (!position) {
          throw new Error(`No open position found for ${symbol}`)
        }

        const positionAmt = parseFloat(position.positionAmt)
        const reverseQty = Math.abs(positionAmt) * 2
        const side = positionAmt > 0 ? 'SELL' : 'BUY'

        const order = await makeRequest(
          config,
          '/fapi/v1/order',
          {
            symbol,
            side,
            quantity: reverseQty,
            type: 'MARKET'
          },
          'POST',
          true
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'REVERSE_POSITION',
                  symbol,
                  originalPosition: positionAmt,
                  reverseQty,
                  side,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    executedQty: order.executedQty,
                    avgPrice: order.avgPrice,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'increase_position': {
        const { symbol, quantity, price } = args as {
          symbol: string
          quantity: number
          price?: number
        }
        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find(
          (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
        )

        if (!position) {
          throw new Error(`No open position found for ${symbol}`)
        }

        const side = parseFloat(position.positionAmt) > 0 ? 'BUY' : 'SELL'
        const params: any = {
          symbol,
          side,
          quantity,
          type: price ? 'LIMIT' : 'MARKET'
        }
        if (price) {
          params.price = price
          params.timeInForce = 'GTC'
        }

        const order = await makeRequest(config, '/fapi/v1/order', params, 'POST', true)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'INCREASE_POSITION',
                  symbol,
                  quantity,
                  side,
                  orderType: order.type,
                  price: order.price,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    executedQty: order.executedQty,
                    avgPrice: order.avgPrice || order.price,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'reduce_position': {
        const { symbol, percentage, price } = args as {
          symbol: string
          percentage: number
          price?: number
        }
        if (percentage < 1 || percentage > 100) {
          throw new Error('Percentage must be between 1 and 100')
        }

        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find(
          (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
        )

        if (!position) {
          throw new Error(`No open position found for ${symbol}`)
        }

        const positionAmt = parseFloat(position.positionAmt)

        // Get symbol info for precision
        const symbolInfo = await getSymbolInfo(config, symbol)
        const stepSize = parseFloat(
          symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize || '0.00001'
        )

        const reduceQty = roundToStepSize(Math.abs(positionAmt * (percentage / 100)), stepSize)
        const side = positionAmt > 0 ? 'SELL' : 'BUY'

        const params: any = {
          symbol,
          side,
          quantity: reduceQty,
          type: price ? 'LIMIT' : 'MARKET',
          reduceOnly: true
        }
        if (price) {
          params.price = price
          params.timeInForce = 'GTC'
        }

        const order = await makeRequest(config, '/fapi/v1/order', params, 'POST', true)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'REDUCE_POSITION',
                  symbol,
                  percentage,
                  reduceQty,
                  side,
                  orderType: order.type,
                  price: order.price,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    executedQty: order.executedQty,
                    avgPrice: order.avgPrice || order.price,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'set_stop_loss': {
        const {
          symbol,
          triggerPrice,
          closePercentage = 100
        } = args as { symbol: string; triggerPrice: number; closePercentage?: number }
        if (closePercentage < 1 || closePercentage > 100) {
          throw new Error('Close percentage must be between 1 and 100')
        }

        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find(
          (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
        )

        if (!position) {
          throw new Error(`No open position found for ${symbol}`)
        }

        const positionAmt = parseFloat(position.positionAmt)

        // Get symbol info for precision
        const symbolInfo = await getSymbolInfo(config, symbol)
        const stepSize = parseFloat(
          symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize || '0.00001'
        )

        const stopQty = roundToStepSize(Math.abs(positionAmt * (closePercentage / 100)), stepSize)
        const side = positionAmt > 0 ? 'SELL' : 'BUY'

        const order = await makeRequest(
          config,
          '/fapi/v1/order',
          {
            symbol,
            side,
            quantity: stopQty,
            type: 'STOP_MARKET',
            stopPrice: triggerPrice,
            reduceOnly: true
          },
          'POST',
          true
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'SET_STOP_LOSS',
                  symbol,
                  triggerPrice,
                  closePercentage,
                  stopQty,
                  side,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    stopPrice: order.stopPrice,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'set_take_profit': {
        const {
          symbol,
          triggerPrice,
          closePercentage = 100
        } = args as { symbol: string; triggerPrice: number; closePercentage?: number }
        if (closePercentage < 1 || closePercentage > 100) {
          throw new Error('Close percentage must be between 1 and 100')
        }

        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find(
          (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
        )

        if (!position) {
          throw new Error(`No open position found for ${symbol}`)
        }

        const positionAmt = parseFloat(position.positionAmt)

        // Get symbol info for precision
        const symbolInfo = await getSymbolInfo(config, symbol)
        const stepSize = parseFloat(
          symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize || '0.00001'
        )

        const tpQty = roundToStepSize(Math.abs(positionAmt * (closePercentage / 100)), stepSize)
        const side = positionAmt > 0 ? 'SELL' : 'BUY'

        const order = await makeRequest(
          config,
          '/fapi/v1/order',
          {
            symbol,
            side,
            quantity: tpQty,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: triggerPrice,
            reduceOnly: true
          },
          'POST',
          true
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'SET_TAKE_PROFIT',
                  symbol,
                  triggerPrice,
                  closePercentage,
                  tpQty,
                  side,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    stopPrice: order.stopPrice,
                    time: new Date(order.updateTime).toISOString()
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'clear_stops': {
        const { symbol } = args as { symbol: string }
        const orders = await makeRequest(config, '/fapi/v1/openOrders', { symbol }, 'GET', true)
        const stopOrders = orders.filter(
          (o: any) =>
            o.type === 'STOP_MARKET' ||
            o.type === 'TAKE_PROFIT_MARKET' ||
            o.type === 'TRAILING_STOP_MARKET'
        )

        const cancelResults = []
        for (const order of stopOrders) {
          const result = await makeRequest(
            config,
            '/fapi/v1/order',
            {
              symbol,
              orderId: order.orderId
            },
            'DELETE',
            true
          )

          cancelResults.push({
            orderId: order.orderId,
            type: order.type,
            status: result.status
          })
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'CLEAR_STOPS',
                  symbol,
                  cancelledCount: cancelResults.length,
                  orders: cancelResults
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_order': {
        const { symbol, orderId } = args as { symbol: string; orderId: string }
        const result = await makeRequest(
          config,
          '/fapi/v1/order',
          {
            symbol,
            orderId
          },
          'GET',
          true
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        }
      }

      case 'cancel_order': {
        const { symbol, orderId } = args as { symbol: string; orderId: string }
        const result = await makeRequest(
          config,
          '/fapi/v1/order',
          {
            symbol,
            orderId
          },
          'DELETE',
          true
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'CANCEL_ORDER',
                  symbol,
                  orderId,
                  result: {
                    orderId: result.orderId,
                    status: result.status,
                    origType: result.origType,
                    side: result.side,
                    price: result.price,
                    origQty: result.origQty
                  }
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'cancel_all_orders': {
        const { symbol } = args as { symbol?: string }
        const params: any = {}
        if (symbol) params.symbol = symbol

        const result = await makeRequest(config, '/fapi/v1/allOpenOrders', params, 'DELETE', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  action: 'CANCEL_ALL_ORDERS',
                  symbol: symbol || 'ALL',
                  code: result.code,
                  msg: result.msg || 'Orders cancelled successfully'
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_order_history': {
        const { symbol, limit = 50 } = args as { symbol?: string; limit?: number }
        const params: any = { limit }
        if (symbol) params.symbol = symbol

        const orders = await makeRequest(config, '/fapi/v1/allOrders', params, 'GET', true)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: orders.length,
                  orders: orders.map((o: any) => ({
                    orderId: o.orderId,
                    symbol: o.symbol,
                    type: o.type,
                    side: o.side,
                    price: o.price,
                    origQty: o.origQty,
                    executedQty: o.executedQty,
                    status: o.status,
                    timeInForce: o.timeInForce,
                    time: new Date(o.time).toISOString(),
                    updateTime: new Date(o.updateTime).toISOString()
                  }))
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_position_history': {
        const {
          symbols,
          last_days = 7,
          limit = 50
        } = args as {
          symbols?: string[]
          last_days?: number
          limit?: number
        }

        // Use default symbols if not provided or empty
        const symbolsToUse = !symbols || symbols.length === 0 ? ['BTCUSDC', 'ETHUSDC'] : symbols

        // Calculate time range based on last_days
        const now = Date.now()
        const startTime = now - last_days * 24 * 60 * 60 * 1000
        const endTime = now

        // Collect all orders and income for all symbols
        let allOrders: any[] = []
        let incomeHistory: any[] = []

        // Get account data once for all symbols
        let accountData: any = null
        try {
          accountData = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        } catch (error: any) {
          // Continue without account data
        }

        // Fetch data for each symbol
        const fetchErrors: any[] = []
        for (const symbol of symbolsToUse) {
          try {
            // Get all orders for this symbol without time restriction first
            const ordersParams: any = {
              symbol,
              limit: 1000
            }
            // Fetch trades instead of orders to get actual execution prices
            const symbolTrades = await makeRequest(
              config,
              '/fapi/v1/userTrades',
              {
                symbol,
                startTime,
                endTime,
                limit: 1000
              },
              'GET',
              true
            )

            // Convert trades to order-like format for compatibility
            const tradesAsOrders = symbolTrades.map((trade: any) => ({
              symbol: trade.symbol,
              orderId: trade.orderId,
              side: trade.side,
              price: trade.price,
              avgPrice: trade.price,
              executedQty: trade.qty,
              time: trade.time,
              status: 'FILLED',
              commission: trade.commission,
              commissionAsset: trade.commissionAsset,
              realizedPnl: trade.realizedPnl
            }))

            // Group trades by orderId to get aggregated order data
            const orderMap: { [key: string]: any } = {}
            tradesAsOrders.forEach((trade: any) => {
              if (!orderMap[trade.orderId]) {
                orderMap[trade.orderId] = {
                  ...trade,
                  trades: [trade]
                }
              } else {
                // Aggregate quantity and calculate weighted average price
                const existingOrder = orderMap[trade.orderId]
                const totalQty =
                  parseFloat(existingOrder.executedQty) + parseFloat(trade.executedQty)
                const weightedPrice =
                  (parseFloat(existingOrder.price) * parseFloat(existingOrder.executedQty) +
                    parseFloat(trade.price) * parseFloat(trade.executedQty)) /
                  totalQty

                existingOrder.executedQty = totalQty.toString()
                existingOrder.price = weightedPrice.toString()
                existingOrder.avgPrice = weightedPrice.toString()
                existingOrder.trades.push(trade)
                existingOrder.time = Math.min(existingOrder.time, trade.time)
              }
            })

            const filledOrders = Object.values(orderMap)
            allOrders = allOrders.concat(filledOrders)

            // Get income for this symbol - paginate to get all records
            let allIncomeForSymbol: any[] = []
            let currentEndTime = endTime

            // Binance API returns max 1000 records per request, so we need to paginate
            while (true) {
              const incomeParams: any = {
                symbol,
                limit: 1000,
                startTime,
                endTime: currentEndTime
              }
              const batch = await makeRequest(config, '/fapi/v1/income', incomeParams, 'GET', true)

              if (batch.length === 0) {
                break // No more records
              }

              allIncomeForSymbol = allIncomeForSymbol.concat(batch)

              // If we got less than 1000 records, we've reached the end
              if (batch.length < 1000) {
                break
              }

              // Set the endTime to the oldest record's time minus 1ms for next batch
              const oldestTime = Math.min(...batch.map((inc: any) => inc.time))
              currentEndTime = oldestTime - 1

              // Safety check to prevent infinite loop
              if (currentEndTime < startTime) {
                break
              }
            }

            incomeHistory = incomeHistory.concat(allIncomeForSymbol)
          } catch (error: any) {
            // Record the error for debugging
            fetchErrors.push({
              symbol,
              error: error.message || 'Unknown error',
              code: error.code
            })
          }
        }

        // Group orders by symbol
        const ordersBySymbol: { [key: string]: any[] } = {}
        allOrders.forEach((order: any) => {
          if (order.status === 'FILLED') {
            if (!ordersBySymbol[order.symbol]) {
              ordersBySymbol[order.symbol] = []
            }
            ordersBySymbol[order.symbol].push(order)
          }
        })

        // Group income by symbol
        const incomeBySymbol: { [key: string]: any[] } = {}
        incomeHistory.forEach((income: any) => {
          if (!incomeBySymbol[income.symbol]) {
            incomeBySymbol[income.symbol] = []
          }
          incomeBySymbol[income.symbol].push(income)
        })

        // Process positions for each symbol
        const positionHistory: any[] = []

        // Also check symbols that have open positions but might not have recent orders
        if (accountData?.positions) {
          for (const pos of accountData.positions) {
            if (parseFloat(pos.positionAmt) !== 0 && !ordersBySymbol[pos.symbol]) {
              ordersBySymbol[pos.symbol] = []
            }
          }
        }

        for (const sym of Object.keys(ordersBySymbol)) {
          const symbolOrders = ordersBySymbol[sym].sort((a: any, b: any) => a.time - b.time)
          const symbolIncome = incomeBySymbol[sym] || []

          // In one-way mode, track net position
          let netAmount = 0
          let positions: any[] = []
          let currentPos: any = null

          // Check if we have an open position currently
          const currentAccountPosition = accountData?.positions?.find((p: any) => p.symbol === sym)
          const hasOpenPosition =
            currentAccountPosition && parseFloat(currentAccountPosition.positionAmt) !== 0

          // If we have an open position, we need to reconstruct its history
          if (hasOpenPosition) {
            const currentPositionAmt = parseFloat(currentAccountPosition.positionAmt)

            // Calculate what the starting position must have been based on orders
            let reconstructedStartAmt = currentPositionAmt
            // Work backwards through orders to find the starting amount
            for (let i = symbolOrders.length - 1; i >= 0; i--) {
              const order = symbolOrders[i]
              const qty = parseFloat(order.executedQty)
              if (order.side === 'BUY') {
                reconstructedStartAmt -= qty
              } else {
                reconstructedStartAmt += qty
              }
            }

            // If we have orders but the reconstructed start amount suggests we're missing the opening orders
            if (symbolOrders.length > 0 && Math.abs(reconstructedStartAmt) > 0.00000001) {
              // Create a synthetic position with the reconstructed starting amount
              netAmount = reconstructedStartAmt
              currentPos = {
                symbol: sym,
                direction: reconstructedStartAmt > 0 ? 'LONG' : 'SHORT',
                entryTime: symbolOrders[0]?.time - 1 || Date.now() - 7 * 24 * 60 * 60 * 1000,
                amount: Math.abs(reconstructedStartAmt),
                maxSize: Math.abs(reconstructedStartAmt),
                orders: [],
                _synthetic: true
              }
            } else if (symbolOrders.length === 0) {
              // No orders at all, create synthetic position for the entire current position
              currentPos = {
                symbol: sym,
                direction: currentPositionAmt > 0 ? 'LONG' : 'SHORT',
                entryTime: Date.now() - 7 * 24 * 60 * 60 * 1000, // Default to 7 days ago
                amount: Math.abs(currentPositionAmt),
                maxSize: Math.abs(currentPositionAmt),
                orders: [],
                _synthetic: true
              }
              netAmount = currentPositionAmt
            }
          }

          for (const order of symbolOrders) {
            const orderQty = parseFloat(order.executedQty)
            const prevNetAmount = netAmount

            // Update net amount based on order side
            if (order.side === 'BUY') {
              netAmount += orderQty
            } else {
              netAmount -= orderQty
            }

            // Check if we're starting a new position (from zero)
            if (Math.abs(prevNetAmount) < 0.00000001 && Math.abs(netAmount) > 0.00000001) {
              // New position starts
              currentPos = {
                symbol: sym,
                direction: netAmount > 0 ? 'LONG' : 'SHORT',
                entryTime: order.time,
                amount: Math.abs(netAmount),
                maxSize: Math.abs(netAmount),
                orders: [order]
              }
            } else if (currentPos) {
              // Update existing position
              currentPos.orders.push(order)
              currentPos.amount = Math.abs(netAmount)
              currentPos.maxSize = Math.max(currentPos.maxSize, Math.abs(netAmount))

              // Check if position closed (returned to zero or very close to zero)
              if (Math.abs(netAmount) < 0.00000001) {
                currentPos.closeTime = order.time
                currentPos.closedSize = currentPos.maxSize
                positions.push(currentPos)
                currentPos = null
              }
              // Check if position reversed (crossed zero to opposite side) but only if significant amount remains
              else if (
                ((prevNetAmount > 0 && netAmount < 0) || (prevNetAmount < 0 && netAmount > 0)) &&
                Math.abs(netAmount) > 0.00000001
              ) {
                // Close current position
                currentPos.closeTime = order.time
                currentPos.closedSize = currentPos.maxSize
                positions.push(currentPos)

                // Start new reversed position with the remainder
                currentPos = {
                  symbol: sym,
                  direction: netAmount > 0 ? 'LONG' : 'SHORT',
                  entryTime: order.time,
                  amount: Math.abs(netAmount),
                  maxSize: Math.abs(netAmount),
                  orders: [order]
                }
              }
            }
          }

          // Handle any open position at the end
          // Only add position if we actually have an open position in the account
          const actualPositionAmt = currentAccountPosition
            ? parseFloat(currentAccountPosition.positionAmt)
            : 0
          if (
            currentPos &&
            Math.abs(netAmount) > 0.00000001 &&
            Math.abs(actualPositionAmt) > 0.00000001
          ) {
            currentPos.closeTime = null
            currentPos.amount = Math.abs(netAmount)
            currentPos.closedSize = currentPos.maxSize - currentPos.amount
            // Double-check direction based on final net amount
            currentPos.direction = netAmount > 0 ? 'LONG' : 'SHORT'
            positions.push(currentPos)
          }

          // Now calculate PnL for each position
          for (const pos of positions) {
            // Get the order IDs for this position to match with income
            const positionOrderIds = pos.orders.map((o: any) => o.orderId)

            // Filter income based on time range AND order IDs if available
            const positionIncome = symbolIncome.filter((inc: any) => {
              const timeMatch = pos.closeTime
                ? inc.time >= pos.entryTime && inc.time <= pos.closeTime
                : inc.time >= pos.entryTime

              // If income has tradeId, try to match with our orders
              if (inc.tradeId && positionOrderIds.length > 0) {
                // Income should be related to trades from our position's orders
                return timeMatch
              }

              return timeMatch
            })

            // Calculate entry price and average close price first
            let entryPrice = 0
            let totalEntryValue = 0
            let totalEntryQty = 0
            let totalCloseValue = 0
            let totalCloseQty = 0

            for (const order of pos.orders) {
              const qty = parseFloat(order.executedQty)
              // We should now have actual trade prices from userTrades endpoint
              const price = parseFloat(order.avgPrice) || parseFloat(order.price) || 0

              if (pos.direction === 'LONG') {
                if (order.side === 'BUY') {
                  // Entry orders for LONG
                  totalEntryValue += qty * price
                  totalEntryQty += qty
                } else {
                  // Exit orders for LONG
                  totalCloseValue += qty * price
                  totalCloseQty += qty
                }
              } else {
                if (order.side === 'SELL') {
                  // Entry orders for SHORT
                  totalEntryValue += qty * price
                  totalEntryQty += qty
                } else {
                  // Exit orders for SHORT
                  totalCloseValue += qty * price
                  totalCloseQty += qty
                }
              }
            }

            // Calculate average prices
            entryPrice = totalEntryQty > 0 ? totalEntryValue / totalEntryQty : 0
            const avgClosePrice = totalCloseQty > 0 ? totalCloseValue / totalCloseQty : 0

            let realizedPnlSum = 0
            let commissionSum = 0
            let fundingFeeSum = 0

            positionIncome.forEach((income: any) => {
              const amount = parseFloat(income.income || '0')
              switch (income.incomeType) {
                case 'REALIZED_PNL':
                  realizedPnlSum += amount
                  break
                case 'COMMISSION':
                  commissionSum += amount
                  break
                case 'FUNDING_FEE':
                  fundingFeeSum += amount
                  break
              }
            })

            // Fallback PnL calculation if no income records found
            if (positionIncome.length === 0 && pos.closedSize > 0) {
              // Calculate PnL from price difference
              const avgEntryPrice = entryPrice
              const avgExitPrice = totalCloseValue / totalCloseQty

              if (pos.direction === 'LONG') {
                realizedPnlSum = (avgExitPrice - avgEntryPrice) * pos.closedSize
              } else {
                realizedPnlSum = (avgEntryPrice - avgExitPrice) * pos.closedSize
              }

              // Estimate commission as 0.1% of trade value (0.05% maker fee * 2 for entry and exit)
              const estimatedCommission = -(avgEntryPrice * pos.closedSize * 0.001)
              commissionSum = estimatedCommission
            }

            const netRealizedPnl = realizedPnlSum + commissionSum + fundingFeeSum
            const totalFees = commissionSum + fundingFeeSum

            let unrealizedPnl = 0
            if (!pos.closeTime && accountData) {
              // Get current unrealized PnL from account for open positions
              const currentPositionData = accountData.positions.find((p: any) => p.symbol === sym)
              unrealizedPnl = currentPositionData
                ? parseFloat(currentPositionData.unrealizedProfit)
                : 0
            }

            positionHistory.push({
              symbol: pos.symbol,
              direction: pos.direction,
              realized_pnl: parseFloat(realizedPnlSum.toFixed(8)),
              net_realized_pnl: parseFloat(netRealizedPnl.toFixed(8)),
              unrealized_pnl: unrealizedPnl,
              total_fees: parseFloat(totalFees.toFixed(8)),
              position_time_setup: new Date(pos.entryTime)
                .toISOString()
                .replace('T', ' ')
                .substring(0, 19),
              position_time_closed: pos.closeTime
                ? new Date(pos.closeTime).toISOString().replace('T', ' ').substring(0, 19)
                : null,
              position_size_closed: parseFloat(pos.closedSize.toFixed(8)),
              position_size_max: parseFloat(pos.maxSize.toFixed(8)),
              position_entry_price: parseFloat(entryPrice.toFixed(8)),
              position_avg_close_price: parseFloat(avgClosePrice.toFixed(8))
            })
          }
        }

        // Sort positions: open positions first (sorted by setup time desc), then closed positions (sorted by close time desc)
        const sortedHistory = positionHistory
          .sort((a, b) => {
            // If both are open positions (null close time), sort by setup time desc
            if (a.position_time_closed === null && b.position_time_closed === null) {
              return (
                new Date(b.position_time_setup).getTime() -
                new Date(a.position_time_setup).getTime()
              )
            }

            // If a is open and b is closed, a comes first
            if (a.position_time_closed === null && b.position_time_closed !== null) {
              return -1
            }

            // If b is open and a is closed, b comes first
            if (a.position_time_closed !== null && b.position_time_closed === null) {
              return 1
            }

            // If both are closed, sort by close time desc
            return (
              new Date(b.position_time_closed).getTime() -
              new Date(a.position_time_closed).getTime()
            )
          })
          .slice(0, limit)

        // Add debug info if result is empty
        if (sortedHistory.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    positions: [],
                    debug: {
                      symbolsUsed: symbolsToUse,
                      totalOrdersFetched: allOrders.length,
                      totalIncomeRecords: incomeHistory.length,
                      ordersBySymbol: Object.keys(ordersBySymbol).map(sym => ({
                        symbol: sym,
                        orderCount: ordersBySymbol[sym].length
                      })),
                      hasAccountData: !!accountData,
                      accountPositions:
                        accountData?.positions
                          ?.filter((p: any) => parseFloat(p.positionAmt) !== 0)
                          .map((p: any) => ({
                            symbol: p.symbol,
                            positionAmt: p.positionAmt,
                            side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT'
                          })) || [],
                      startTime: new Date(startTime).toISOString(),
                      endTime: new Date(endTime).toISOString(),
                      fetchErrors: fetchErrors
                    }
                  },
                  null,
                  2
                )
              }
            ]
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sortedHistory, null, 2)
            }
          ]
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: error.message || 'Unknown error occurred',
              tool: name,
              args
            },
            null,
            2
          )
        }
      ]
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(() => {
  process.exit(1)
})
