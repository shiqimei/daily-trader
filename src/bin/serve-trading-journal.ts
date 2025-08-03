/**
 * Trading Journal Dashboard - serves trading journal data
 * It renders all trades as a modern responsive web ui.
 */

import { db } from '@/database'
import dayjs from 'dayjs'
import { createServer } from 'http'
import Database from 'better-sqlite3'
import { promises as fs } from 'fs'
import { join } from 'path'
import { logger } from '@/utils/logger'

interface Trade {
  id: number
  date: string | null
  time: string | null
  symbol: string
  setup_type: string
  side: 'LONG' | 'SHORT'
  qty: number
  entry_price: number
  stop_loss: number
  target: number
  exit_price: number | null
  exit_time: string | null
  pnl: number | null
  r_multiple: number | null
  fees: number
  net_pnl: number | null
  market_context: string | null
  trend: string | null
  key_levels: string | null
  entry_trigger: string | null
  risk_percent: number | null
  position_size_rationale: string | null
  confluence_factors: number | null
  exit_reason: string | null
  trade_grade: string | null
  execution_quality: string | null
  mistakes: string | null
  lessons: string | null
  emotional_state: string | null
  followed_rules: number | null
  account_balance: number | null
  win_loss: 'WIN' | 'LOSS' | 'BE' | null
  created_at: string
  updated_at: string
}


const PORT = process.env.PORT || 3001

// Database statements
const getAllTradesStmt = db.prepare(`
  SELECT * FROM trades 
  ORDER BY id DESC
`)

const getTradesWithLimitStmt = db.prepare(`
  SELECT * FROM trades 
  ORDER BY id DESC 
  LIMIT ?
`)


function getTrades(limit?: number): Trade[] {
  try {
    if (limit && limit > 0) {
      return getTradesWithLimitStmt.all(limit) as Trade[]
    }
    return getAllTradesStmt.all() as Trade[]
  } catch (error) {
    logger.error({ error }, 'Failed to get trades')
    return []
  }
}


function formatDateTime(dateStr: string | null, timeStr: string | null): string {
  if (!dateStr) return 'Not executed'
  const fullDateTime = timeStr ? `${dateStr} ${timeStr}` : dateStr
  return dayjs(fullDateTime).format('MMM D, YYYY HH:mm:ss')
}

function formatTradeStatus(trade: Trade): string {
  if (!trade.exit_price) return 'OPEN'
  return trade.win_loss || 'CLOSED'
}

function formatPrice(price: number | null): string {
  if (!price) return 'N/A'
  return price.toFixed(4)
}

function formatPnL(pnl: number | null): string {
  if (pnl === null) return 'N/A'
  const formatted = pnl.toFixed(2)
  if (pnl > 0) return `+${formatted}`
  return formatted
}

function getStatusColor(trade: Trade): string {
  if (!trade.exit_price) return 'status-open'
  switch (trade.win_loss) {
    case 'WIN': return 'status-win'
    case 'LOSS': return 'status-loss'
    case 'BE': return 'status-be'
    default: return 'status-open'
  }
}

function renderHTML(trades: Trade[]): string {
  const tradeCards = trades
    .map(trade => {
      const statusColor = getStatusColor(trade)
      const rr = trade.target && trade.entry_price && trade.stop_loss
        ? Math.abs((trade.target - trade.entry_price) / (trade.entry_price - trade.stop_loss))
        : 0

      return `
    <div class="trade-card ${statusColor}" data-trade-id="${trade.id}">
      <div class="trade-header">
        <div class="trade-header-left">
          <div class="trade-id">Trade #${trade.id}</div>
          <div class="trade-symbol">${trade.symbol}</div>
          <div class="trade-status">${formatTradeStatus(trade)}</div>
        </div>
        <div class="trade-header-right">
          <div class="trade-side ${trade.side.toLowerCase()}">${trade.side}</div>
          <div class="trade-setup">${trade.setup_type}</div>
        </div>
      </div>
      
      <div class="trade-content">
        <div class="trade-section">
          <h4>Entry Details</h4>
          <div class="trade-detail">
            <span class="label">Date/Time:</span>
            <span>${formatDateTime(trade.date, trade.time)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Entry Price:</span>
            <span>${formatPrice(trade.entry_price)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Stop Loss:</span>
            <span>${formatPrice(trade.stop_loss)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Target:</span>
            <span>${formatPrice(trade.target)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Risk/Reward:</span>
            <span>1:${rr.toFixed(2)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Position Size:</span>
            <span>${trade.qty}</span>
          </div>
        </div>
        
        ${trade.exit_price ? `
        <div class="trade-section">
          <h4>Exit Details</h4>
          <div class="trade-detail">
            <span class="label">Exit Time:</span>
            <span>${formatDateTime(null, trade.exit_time)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Exit Price:</span>
            <span>${formatPrice(trade.exit_price)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Exit Reason:</span>
            <span>${trade.exit_reason || 'N/A'}</span>
          </div>
          <div class="trade-detail">
            <span class="label">P&L:</span>
            <span class="${trade.pnl && trade.pnl > 0 ? 'profit' : 'loss'}">${formatPnL(trade.pnl)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Net P&L:</span>
            <span class="${trade.net_pnl && trade.net_pnl > 0 ? 'profit' : 'loss'}">${formatPnL(trade.net_pnl)}</span>
          </div>
          <div class="trade-detail">
            <span class="label">R-Multiple:</span>
            <span>${trade.r_multiple?.toFixed(2) || 'N/A'}</span>
          </div>
        </div>
        ` : ''}
        
        ${trade.market_context ? `
        <div class="trade-section">
          <h4>Pre-Trade Analysis</h4>
          <div class="trade-detail">
            <span class="label">Market Context:</span>
            <span>${trade.market_context}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Trend:</span>
            <span>${trade.trend || 'N/A'}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Entry Trigger:</span>
            <span>${trade.entry_trigger || 'N/A'}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Confluence Factors:</span>
            <span>${trade.confluence_factors || 'N/A'}/5</span>
          </div>
        </div>
        ` : ''}
        
        ${trade.trade_grade ? `
        <div class="trade-section">
          <h4>Post-Trade Review</h4>
          <div class="trade-detail">
            <span class="label">Grade:</span>
            <span class="grade-${trade.trade_grade?.toLowerCase()}">${trade.trade_grade}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Execution Quality:</span>
            <span>${trade.execution_quality || 'N/A'}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Emotional State:</span>
            <span>${trade.emotional_state || 'N/A'}</span>
          </div>
          <div class="trade-detail">
            <span class="label">Followed Rules:</span>
            <span>${trade.followed_rules ? 'Yes' : 'No'}</span>
          </div>
          ${trade.mistakes ? `
          <div class="trade-detail">
            <span class="label">Mistakes:</span>
            <span>${trade.mistakes}</span>
          </div>
          ` : ''}
          ${trade.lessons ? `
          <div class="trade-detail">
            <span class="label">Lessons:</span>
            <span>${trade.lessons}</span>
          </div>
          ` : ''}
        </div>
        ` : ''}
      </div>
    </div>
  `
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trading Journal Dashboard</title>
  <style>
    :root {
      --background: 220 16% 13%;
      --foreground: 0 0% 100%;
      --card: 222 16% 16%;
      --card-foreground: 0 0% 100%;
      --border: 217 15% 20%;
      --primary: 213 94% 64%;
      --primary-foreground: 0 0% 100%;
      --secondary: 215 14% 20%;
      --secondary-foreground: 0 0% 100%;
      --muted: 217 15% 20%;
      --muted-foreground: 215 15% 60%;
      --success: 120 100% 40%;
      --danger: 0 84% 60%;
      --warning: 45 100% 50%;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background-color: hsl(var(--background));
      color: hsl(var(--foreground));
      line-height: 1.6;
      min-height: 100vh;
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
    }
    
    h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 2rem;
      text-align: center;
      background: linear-gradient(to right, hsl(var(--primary)), hsl(var(--primary) / 0.8));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    
    .trade-grid {
      display: grid;
      gap: 1.5rem;
      grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
    }
    
    .trade-card {
      background-color: hsl(var(--card));
      border: 1px solid hsl(var(--border));
      border-radius: 0.5rem;
      overflow: hidden;
      transition: all 0.3s ease;
    }
    
    .trade-card:hover {
      box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
      transform: translateY(-1px);
    }
    
    .trade-card.status-win {
      border-left: 4px solid hsl(var(--success));
    }
    
    .trade-card.status-loss {
      border-left: 4px solid hsl(var(--danger));
    }
    
    .trade-card.status-be {
      border-left: 4px solid hsl(var(--warning));
    }
    
    .trade-card.status-open {
      border-left: 4px solid hsl(var(--primary));
    }
    
    .trade-header {
      background-color: hsl(var(--muted) / 0.5);
      border-bottom: 1px solid hsl(var(--border));
      padding: 1rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .trade-header-left, .trade-header-right {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    
    .trade-id {
      font-size: 1.125rem;
      font-weight: 600;
      color: hsl(var(--primary));
    }
    
    .trade-symbol {
      font-size: 1rem;
      font-weight: 500;
    }
    
    .trade-status {
      font-size: 0.875rem;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      background-color: hsl(var(--primary) / 0.2);
      color: hsl(var(--primary));
    }
    
    .trade-side {
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.25rem 0.75rem;
      border-radius: 0.25rem;
    }
    
    .trade-side.long {
      background-color: hsl(var(--success) / 0.2);
      color: hsl(var(--success));
    }
    
    .trade-side.short {
      background-color: hsl(var(--danger) / 0.2);
      color: hsl(var(--danger));
    }
    
    .trade-setup {
      font-size: 0.875rem;
      color: hsl(var(--muted-foreground));
    }
    
    .trade-content {
      padding: 1.5rem;
    }
    
    .trade-section {
      margin-bottom: 1.5rem;
    }
    
    .trade-section:last-child {
      margin-bottom: 0;
    }
    
    .trade-section h4 {
      font-size: 0.875rem;
      font-weight: 600;
      color: hsl(var(--primary));
      margin-bottom: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .trade-detail {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 0;
      border-bottom: 1px solid hsl(var(--border) / 0.5);
    }
    
    .trade-detail:last-child {
      border-bottom: none;
    }
    
    .trade-detail .label {
      font-size: 0.875rem;
      color: hsl(var(--muted-foreground));
    }
    
    .trade-detail span:last-child {
      font-size: 0.875rem;
      font-weight: 500;
    }
    
    .profit {
      color: hsl(var(--success));
    }
    
    .loss {
      color: hsl(var(--danger));
    }
    
    .grade-a {
      color: hsl(var(--success));
      font-weight: 600;
    }
    
    .grade-b {
      color: hsl(120 60% 50%);
      font-weight: 600;
    }
    
    .grade-c {
      color: hsl(var(--warning));
      font-weight: 600;
    }
    
    .grade-d, .grade-f {
      color: hsl(var(--danger));
      font-weight: 600;
    }
    
    .no-trades {
      text-align: center;
      color: hsl(var(--muted-foreground));
      padding: 4rem 2rem;
      font-size: 1.125rem;
    }
    
    @media (max-width: 768px) {
      .container {
        padding: 1rem;
      }
      
      h1 {
        font-size: 2rem;
      }
      
      .trade-grid {
        grid-template-columns: 1fr;
      }
      
      .trade-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.5rem;
      }
      
      .trade-header-right {
        width: 100%;
        justify-content: space-between;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Trading Journal Dashboard</h1>
    
    <div class="trade-grid" id="tradeGrid">
        ${
          trades.length > 0
            ? tradeCards
            : '<div class="no-trades">No trades found. Start trading to see your journal entries here.</div>'
        }
    </div>
  </div>
  
</body>
</html>`
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)

  if (url.pathname === '/') {
    const limit = url.searchParams.get('limit')
    const trades = getTrades(limit ? parseInt(limit) : 50)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(renderHTML(trades))
    return
  }
  
  if (url.pathname === '/api/trades') {
    const limit = url.searchParams.get('limit')
    const trades = getTrades(limit ? parseInt(limit) : undefined)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(trades))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
})

server.listen(PORT, () => {
  logger.info(`Trading Journal Dashboard running at http://localhost:${PORT}`)
})

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down server...')
  server.close(() => {
    db.close()
    process.exit(0)
  })
})

process.on('SIGTERM', () => {
  logger.info('Shutting down server...')
  server.close(() => {
    db.close()
    process.exit(0)
  })
})