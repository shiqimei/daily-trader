import WebSocket from 'ws'
import { OrderbookSnapshot } from '../types/orderbook'

interface BinanceDepthUpdate {
  e: string // Event type
  E: number // Event time
  s: string // Symbol
  U: number // First update ID in event
  u: number // Final update ID in event
  b: [string, string][] // Bids to be updated
  a: [string, string][] // Asks to be updated
}

interface BinanceDepthSnapshot {
  lastUpdateId: number
  bids: [string, string][]
  asks: [string, string][]
}

export class BinanceOrderbookWS {
  private ws: WebSocket | null = null
  private orderbook: OrderbookSnapshot = {
    timestamp: 0,
    bids: [],
    asks: []
  }
  private lastUpdateId: number = 0
  private isInitialized: boolean = false
  private isSyncing: boolean = false
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 5
  private reconnectDelay: number = 1000
  private lastResyncTime: number = 0
  private resyncCooldown: number = 5000 // 5 seconds between resyncs
  private missedUpdateCount: number = 0
  private maxMissedUpdates: number = 5 // Resync after 5 missed updates

  constructor(
    private readonly symbol: string,
    private readonly onSnapshot: (snapshot: OrderbookSnapshot) => void,
    private readonly depthLevels: number = 20,
    private readonly updateSpeed: number = 100, // ms (100ms or 1000ms)
    private readonly onStatusChange?: (status: string) => void
  ) {}

  async connect(): Promise<void> {
    this.onStatusChange?.('Fetching snapshot...')
    // First get a snapshot from REST API
    await this.fetchSnapshot()

    // Then connect to WebSocket
    this.onStatusChange?.('Connecting to WebSocket...')
    this.connectWebSocket()
  }

  private async fetchSnapshot(): Promise<void> {
    // Prevent multiple simultaneous syncs
    if (this.isSyncing) {
      return
    }
    
    this.isSyncing = true
    this.missedUpdateCount = 0
    this.onStatusChange?.('Syncing orderbook...')
    
    try {
      const response = await fetch(
        `https://fapi.binance.com/fapi/v1/depth?symbol=${this.symbol}&limit=${this.depthLevels}`
      )

      if (!response.ok) {
        throw new Error(`Failed to fetch orderbook snapshot: ${response.statusText}`)
      }

      const data: BinanceDepthSnapshot = await response.json()

      this.lastUpdateId = data.lastUpdateId

      // Convert to our format
      this.orderbook = {
        timestamp: Date.now(),
        bids: data.bids.slice(0, this.depthLevels).map(([price, size]) => ({
          price: parseFloat(price),
          size: parseFloat(size)
        })),
        asks: data.asks.slice(0, this.depthLevels).map(([price, size]) => ({
          price: parseFloat(price),
          size: parseFloat(size)
        }))
      }

      this.isInitialized = true
      this.isSyncing = false
      this.onSnapshot(this.orderbook)
    } catch (error) {
      this.isSyncing = false
      console.error('Failed to fetch orderbook snapshot:', error)
      throw error
    }
  }

  private connectWebSocket(): void {
    const streamName = `${this.symbol.toLowerCase()}@depth@${this.updateSpeed}ms`
    const wsUrl = `wss://fstream.binance.com/ws/${streamName}`

    console.log(`Connecting to WebSocket: ${wsUrl}`)

    this.ws = new WebSocket(wsUrl)

    this.ws.on('open', () => {
      console.log('WebSocket connected')
      this.reconnectAttempts = 0
      this.onStatusChange?.('Connected')
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
      this.onStatusChange?.('Error')
    })

    this.ws.on('close', () => {
      console.log('WebSocket disconnected')
      this.onStatusChange?.('Disconnected')
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
    // Skip if not initialized or currently syncing
    if (!this.isInitialized || this.isSyncing) {
      return
    }

    // Skip old updates
    if (update.u <= this.lastUpdateId) {
      return
    }

    // Check if this update can be applied
    // The first processed update should have U <= lastUpdateId+1 <= u
    if (update.U <= this.lastUpdateId + 1 && update.u >= this.lastUpdateId + 1) {
      // This update is valid, process it
      this.missedUpdateCount = 0 // Reset missed count on successful update
    } else if (update.U > this.lastUpdateId + 1) {
      // We missed some updates
      this.missedUpdateCount++
      
      // Only log and resync if we've missed too many updates
      if (this.missedUpdateCount >= this.maxMissedUpdates) {
        const now = Date.now()
        if (now - this.lastResyncTime > this.resyncCooldown) {
          console.warn(`Too many missed updates (${this.missedUpdateCount}), resyncing...`)
          this.isInitialized = false
          this.lastResyncTime = now
          this.fetchSnapshot()
        }
      }
      return
    } else {
      // This update is too old, skip it
      return
    }

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

    // Update timestamp and lastUpdateId
    this.orderbook.timestamp = update.E
    this.lastUpdateId = update.u

    // Emit snapshot
    this.onSnapshot(this.orderbook)
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached')
      this.onStatusChange?.('Connection failed')
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)

    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    )
    
    this.onStatusChange?.(`Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`)

    setTimeout(() => {
      this.connect()
    }, delay)
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  getCurrentOrderbook(): OrderbookSnapshot {
    return {
      ...this.orderbook,
      bids: [...this.orderbook.bids],
      asks: [...this.orderbook.asks]
    }
  }
}
