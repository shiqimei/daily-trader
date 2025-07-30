import { WebSocket } from 'ws'
import { OrderbookSnapshot, OrderLevel } from '../types/orderbook'

interface BinanceDepthUpdate {
  e: string // Event type
  E: number // Event time
  s: string // Symbol
  U: number // First update ID in event
  u: number // Final update ID in event
  b: [string, string][] // Bids to be updated
  a: [string, string][] // Asks to be updated
}

export class BinanceWebsocket {
  private ws: WebSocket | null = null
  private orderbook: OrderbookSnapshot = {
    timestamp: 0,
    bids: [],
    asks: []
  }
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 5
  private reconnectDelay: number = 1000

  constructor(
    private readonly symbol: string,
    private readonly onSnapshot: (snapshot: OrderbookSnapshot) => void,
    private readonly depthLevels: number = 20,
    private readonly updateSpeed: number = 100 // ms
  ) {}

  async connect(): Promise<void> {
    this.connectWebSocket()
  }

  private connectWebSocket(): void {
    const streamName = `${this.symbol.toLowerCase()}@depth@${this.updateSpeed}ms`
    const wsUrl = `wss://fstream.binance.com/ws/${streamName}`

    console.log(`Connecting to WebSocket: ${wsUrl}`)

    this.ws = new WebSocket(wsUrl)

    this.ws.on('open', () => {
      console.log('WebSocket connected')
      this.reconnectAttempts = 0
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const update: BinanceDepthUpdate = JSON.parse(data.toString())
        this.processUpdate(update)
      } catch (error) {
        console.error('Failed to process WebSocket message:', error)
      }
    })

    this.ws.on('error', (error: Error) => {
      console.error('WebSocket error:', error)
    })

    this.ws.on('close', () => {
      console.log('WebSocket disconnected')
      this.handleReconnect()
    })

    // Send ping every 30 seconds to keep connection alive
    const pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping()
      } else {
        clearInterval(pingInterval)
      }
    }, 30000)
  }

  private processUpdate(update: BinanceDepthUpdate): void {
    // Update bids
    for (const [priceStr, sizeStr] of update.b) {
      const price = parseFloat(priceStr)
      const size = parseFloat(sizeStr)

      if (size === 0) {
        // Remove this price level
        this.orderbook.bids = this.orderbook.bids.filter(bid => bid.price !== price)
      } else {
        // Update or add this price level
        const index = this.orderbook.bids.findIndex(bid => bid.price === price)
        if (index >= 0) {
          this.orderbook.bids[index].size = size
        } else {
          // Insert in correct position (sorted by price descending)
          const insertIndex = this.orderbook.bids.findIndex(bid => bid.price < price)
          if (insertIndex >= 0) {
            this.orderbook.bids.splice(insertIndex, 0, { price, size })
          } else {
            this.orderbook.bids.push({ price, size })
          }
        }
      }
    }

    // Update asks
    for (const [priceStr, sizeStr] of update.a) {
      const price = parseFloat(priceStr)
      const size = parseFloat(sizeStr)

      if (size === 0) {
        // Remove this price level
        this.orderbook.asks = this.orderbook.asks.filter(ask => ask.price !== price)
      } else {
        // Update or add this price level
        const index = this.orderbook.asks.findIndex(ask => ask.price === price)
        if (index >= 0) {
          this.orderbook.asks[index].size = size
        } else {
          // Insert in correct position (sorted by price ascending)
          const insertIndex = this.orderbook.asks.findIndex(ask => ask.price > price)
          if (insertIndex >= 0) {
            this.orderbook.asks.splice(insertIndex, 0, { price, size })
          } else {
            this.orderbook.asks.push({ price, size })
          }
        }
      }
    }

    // Trim to depth levels
    this.orderbook.bids = this.orderbook.bids.slice(0, this.depthLevels)
    this.orderbook.asks = this.orderbook.asks.slice(0, this.depthLevels)

    // Update timestamp
    this.orderbook.timestamp = update.E

    // Only emit if we have both bids and asks
    if (this.orderbook.bids.length > 0 && this.orderbook.asks.length > 0) {
      this.onSnapshot(this.orderbook)
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached')
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    setTimeout(() => {
      this.connectWebSocket()
    }, delay)
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}