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
          description: 'Number of klines to return (max 1500)',
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
      'Get top USDC trading pairs optimized for day trading with volatility and volume filters',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of top symbols to return', default: 10 },
        minVolatility: {
          type: 'number',
          description: 'Minimum 24hr price change % (absolute)',
          default: 2
        },
        maxVolatility: {
          type: 'number',
          description: 'Maximum 24hr price change % (absolute)',
          default: 15
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
    description: 'Get all open positions',
    inputSchema: {
      type: 'object',
      properties: {}
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
    name: 'set_trailing_stop',
    description: 'Set trailing stop order',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair symbol' },
        activationPrice: { type: 'number', description: 'Price to activate trailing' },
        callbackRate: { type: 'number', description: 'Callback rate percentage (0.1-5)' }
      },
      required: ['symbol', 'activationPrice', 'callbackRate']
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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
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
                },
                null,
                2
              )
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
          results[interval] = klines.map((k: any[]) => ({
            time: new Date(k[0]).toISOString(),
            open: k[1],
            high: k[2],
            low: k[3],
            close: k[4],
            volume: k[5]
          }))
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  symbol,
                  intervals: results
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
          minVolatility = 2,
          maxVolatility = 15
        } = args as {
          limit?: number
          minVolatility?: number
          maxVolatility?: number
        }

        // Get 24hr tickers first
        const tickers = await makeRequest(config, '/fapi/v1/ticker/24hr')

        // Filter USDC pairs and apply day trading filters
        const filteredPairs = tickers
          .filter((ticker: any) => {
            if (!ticker.symbol.endsWith('USDC')) return false

            const priceChange = Math.abs(parseFloat(ticker.priceChangePercent))
            const currentVolume = parseFloat(ticker.quoteVolume)

            // Day trading filters
            return (
              priceChange >= minVolatility && // Minimum volatility for quick moves
              priceChange <= maxVolatility && // Maximum volatility to avoid extreme risk
              currentVolume > 1000000 // Minimum absolute volume threshold (1M USDC)
            )
          })
          .map((ticker: any) => {
            const priceChange = parseFloat(ticker.priceChangePercent)
            const volatility = Math.abs(priceChange)

            // Day trading score based on volatility and volume
            const volatilityScore = volatility / 10 // 0-1.5 typical range
            const volumeScore = Math.min(parseFloat(ticker.quoteVolume) / 10000000, 1) // Normalize by 10M
            const dayTradingScore = volatilityScore * 0.7 + volumeScore * 0.3

            return {
              symbol: ticker.symbol,
              volume: ticker.volume,
              quoteVolume: ticker.quoteVolume,
              priceChangePercent: ticker.priceChangePercent,
              lastPrice: ticker.lastPrice,
              volatility: volatility.toFixed(2),
              dayTradingScore: dayTradingScore.toFixed(3)
            }
          })
          .sort((a: any, b: any) => parseFloat(b.dayTradingScore) - parseFloat(a.dayTradingScore))
          .slice(0, limit)

        // Get 4-hour klines for each selected symbol
        const symbolsWithKlines = await Promise.all(
          filteredPairs.map(async (pair: any) => {
            try {
              const klines = await makeRequest(config, '/fapi/v1/klines', {
                symbol: pair.symbol,
                interval: '4h',
                limit: 20
              })

              // Format klines data: [open_time, open, high, low, close, volume, close_time, quote_volume, count, taker_buy_volume, taker_buy_quote_volume, ignore]
              const formattedKlines = klines.map((kline: any[]) => ({
                openTime: parseInt(kline[0]),
                open: parseFloat(kline[1]),
                high: parseFloat(kline[2]),
                low: parseFloat(kline[3]),
                close: parseFloat(kline[4]),
                volume: parseFloat(kline[5]),
                closeTime: parseInt(kline[6]),
                quoteVolume: parseFloat(kline[7]),
                trades: parseInt(kline[8]),
                takerBuyVolume: parseFloat(kline[9]),
                takerBuyQuoteVolume: parseFloat(kline[10])
              }))

              return {
                ...pair,
                klines4h: formattedKlines
              }
            } catch (error) {
              console.error(`Failed to fetch klines for ${pair.symbol}:`, error)
              return {
                ...pair,
                klines4h: []
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
                  topSymbols: symbolsWithKlines,
                  count: symbolsWithKlines.length,
                  filters: {
                    minVolatility: `${minVolatility}%`,
                    maxVolatility: `${maxVolatility}%`,
                    minAbsoluteVolume: '1M USDC'
                  },
                  klinesInfo: {
                    interval: '4h',
                    limit: 20,
                    description: 'Last 20 four-hour candles for each symbol'
                  },
                  timestamp: new Date().toISOString()
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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: activePositions.length,
                  positions: activePositions.map((p: any) => ({
                    symbol: p.symbol,
                    side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                    positionAmt: p.positionAmt,
                    entryPrice: p.entryPrice,
                    markPrice: p.markPrice,
                    unrealizedProfit: p.unrealizedProfit,
                    isolatedWallet: p.isolatedWallet,
                    notional: p.notional,
                    leverage: p.leverage,
                    marginType: p.marginType,
                    liquidationPrice: p.liquidationPrice,
                    updateTime: new Date(p.updateTime).toISOString()
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

      // Position Management
      case 'open_long': {
        const { symbol, quantity, price } = args as {
          symbol: string
          quantity: number
          price?: number
        }
        const params: any = {
          symbol,
          side: 'BUY',
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
        const { symbol, quantity, price } = args as {
          symbol: string
          quantity: number
          price?: number
        }
        const params: any = {
          symbol,
          side: 'SELL',
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

      case 'set_trailing_stop': {
        const { symbol, activationPrice, callbackRate } = args as {
          symbol: string
          activationPrice: number
          callbackRate: number
        }
        if (callbackRate < 0.1 || callbackRate > 5) {
          throw new Error('Callback rate must be between 0.1 and 5')
        }

        const account = await makeRequest(config, '/fapi/v2/account', {}, 'GET', true)
        const position = account.positions.find(
          (p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0
        )

        if (!position) {
          throw new Error(`No open position found for ${symbol}`)
        }

        const positionAmt = parseFloat(position.positionAmt)
        const side = positionAmt > 0 ? 'SELL' : 'BUY'

        const order = await makeRequest(
          config,
          '/fapi/v1/order',
          {
            symbol,
            side,
            quantity: Math.abs(positionAmt),
            type: 'TRAILING_STOP_MARKET',
            activationPrice,
            callbackRate
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
                  action: 'SET_TRAILING_STOP',
                  symbol,
                  activationPrice,
                  callbackRate,
                  side,
                  order: {
                    orderId: order.orderId,
                    status: order.status,
                    activatePrice: order.activationPrice,
                    priceRate: order.callbackRate,
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
