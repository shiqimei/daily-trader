import * as WebSocket from 'ws'

export interface AccountUpdate {
  eventType: 'ACCOUNT_UPDATE'
  eventTime: number
  balances: Array<{
    asset: string
    walletBalance: string
    crossWalletBalance: string
    balanceChange: string
  }>
  positions: Array<{
    symbol: string
    positionAmt: string
    entryPrice: string
    markPrice: string
    unRealizedProfit: string
    positionSide: string
  }>
}

export interface OrderUpdate {
  eventType: 'ORDER_TRADE_UPDATE'
  eventTime: number
  symbol: string
  clientOrderId: string
  side: 'BUY' | 'SELL'
  orderType: string
  timeInForce: string
  originalQuantity: string
  originalPrice: string
  averagePrice: string
  stopPrice: string
  executionType: string
  orderStatus: string
  orderId: number
  lastFilledQuantity: string
  cumulativeFilledQuantity: string
  lastFilledPrice: string
  commissionAsset: string
  commission: string
  orderTradeTime: number
  tradeId: number
  bidsNotional: string
  askNotional: string
  isMakerSide: boolean
  isReduceOnly: boolean
  workingType: string
  originalOrderType: string
  positionSide: string
  closePosition: boolean
  activationPrice: string
  callbackRate: string
  realizedProfit: string
}

type UserDataCallback = (data: AccountUpdate | OrderUpdate) => void

export class BinanceUserDataWS {
  private ws: WebSocket | null = null
  private listenKey: string | null = null
  private pingInterval: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private isConnected = false
  private callback: UserDataCallback
  private logCallback?: (message: string, level: 'info' | 'error' | 'warn') => void

  constructor(
    private mcpClient: any,
    callback: UserDataCallback,
    logCallback?: (message: string, level: 'info' | 'error' | 'warn') => void
  ) {
    this.callback = callback
    this.logCallback = logCallback
  }

  private log(message: string, level: 'info' | 'error' | 'warn' = 'info') {
    if (this.logCallback) {
      this.logCallback(message, level)
    }
  }

  async connect(): Promise<void> {
    try {
      // Get listen key from REST API
      const result = await this.mcpClient.callTool({
        name: 'create_listen_key',
        arguments: {}
      })
      
      const response = JSON.parse((result.content as any)[0].text)
      this.listenKey = response.listenKey
      
      if (!this.listenKey) {
        throw new Error('Failed to get listen key')
      }
      
      // Connect to WebSocket
      const wsUrl = `wss://fstream.binance.com/ws/${this.listenKey}`
      this.log('Connecting to User Data WebSocket...', 'info')
      
      this.ws = new WebSocket(wsUrl)
      
      this.ws.on('open', () => {
        this.log('✓ User Data WebSocket connected', 'info')
        this.isConnected = true
        this.reconnectAttempts = 0
        
        // Ping every 30 minutes to keep connection alive
        this.pingInterval = setInterval(() => {
          this.keepAlive()
        }, 30 * 60 * 1000)
      })
      
      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString())
          
          if (message.e === 'ACCOUNT_UPDATE') {
            const update: AccountUpdate = {
              eventType: 'ACCOUNT_UPDATE',
              eventTime: message.E,
              balances: message.a.B || [],
              positions: message.a.P || []
            }
            this.callback(update)
          } else if (message.e === 'ORDER_TRADE_UPDATE') {
            const order = message.o
            const update: OrderUpdate = {
              eventType: 'ORDER_TRADE_UPDATE',
              eventTime: message.E,
              symbol: order.s,
              clientOrderId: order.c,
              side: order.S,
              orderType: order.o,
              timeInForce: order.f,
              originalQuantity: order.q,
              originalPrice: order.p,
              averagePrice: order.ap,
              stopPrice: order.sp,
              executionType: order.x,
              orderStatus: order.X,
              orderId: order.i,
              lastFilledQuantity: order.l,
              cumulativeFilledQuantity: order.z,
              lastFilledPrice: order.L,
              commissionAsset: order.N,
              commission: order.n,
              orderTradeTime: order.T,
              tradeId: order.t,
              bidsNotional: order.b,
              askNotional: order.a,
              isMakerSide: order.m,
              isReduceOnly: order.R,
              workingType: order.wt,
              originalOrderType: order.ot,
              positionSide: order.ps,
              closePosition: order.cp,
              activationPrice: order.AP,
              callbackRate: order.cr,
              realizedProfit: order.rp
            }
            this.callback(update)
          }
        } catch (error) {
          this.log(`Error parsing user data message: ${error}`, 'error')
        }
      })
      
      this.ws.on('error', (error) => {
        this.log(`User Data WebSocket error: ${error}`, 'error')
      })
      
      this.ws.on('close', () => {
        this.log('User Data WebSocket disconnected', 'warn')
        this.isConnected = false
        
        if (this.pingInterval) {
          clearInterval(this.pingInterval)
          this.pingInterval = null
        }
        
        // Attempt to reconnect
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++
          this.log(`Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'info')
          setTimeout(() => this.connect(), this.reconnectDelay)
        }
      })
      
    } catch (error) {
      this.log(`Failed to connect to user data stream: ${error}`, 'error')
      throw error
    }
  }
  
  private async keepAlive() {
    if (!this.listenKey) return
    
    try {
      await this.mcpClient.callTool({
        name: 'ping_listen_key',
        arguments: { listenKey: this.listenKey }
      })
    } catch (error) {
      this.log(`Failed to keep listen key alive: ${error}`, 'error')
    }
  }
  
  disconnect() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    
    this.isConnected = false
  }
  
  getConnectionStatus(): boolean {
    return this.isConnected
  }
}