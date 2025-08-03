/**
 * Trading Journal Dashboard - serves trading journal data
 * It renders all trades as a modern responsive web ui with TradingView-inspired design.
 */

import { db } from '@/database'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { createServer } from 'http'
import Database from 'better-sqlite3'
import { promises as fs } from 'fs'
import { join } from 'path'
import { logger } from '@/utils/logger'

// Configure dayjs with timezone support
dayjs.extend(utc)
dayjs.extend(timezone)
const DISPLAY_TIMEZONE = 'Asia/Singapore' // UTC+8

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

// Initialize trades table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    time TEXT,
    symbol TEXT NOT NULL,
    setup_type TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
    qty REAL NOT NULL,
    entry_price REAL NOT NULL,
    stop_loss REAL NOT NULL,
    target REAL NOT NULL,
    exit_price REAL,
    exit_time TEXT,
    pnl REAL,
    r_multiple REAL,
    fees REAL DEFAULT 0,
    net_pnl REAL,
    market_context TEXT,
    trend TEXT,
    key_levels TEXT,
    entry_trigger TEXT,
    risk_percent REAL,
    position_size_rationale TEXT,
    confluence_factors INTEGER,
    exit_reason TEXT,
    trade_grade TEXT,
    execution_quality TEXT,
    mistakes TEXT,
    lessons TEXT,
    emotional_state TEXT,
    followed_rules INTEGER,
    account_balance REAL,
    win_loss TEXT CHECK (win_loss IN ('WIN', 'LOSS', 'BE', NULL)),
    cumulative_pnl REAL,
    win_rate REAL,
    avg_win REAL,
    avg_loss REAL,
    max_drawdown REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)

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
  // Parse as UTC and convert to UTC+8
  return dayjs.utc(fullDateTime).tz(DISPLAY_TIMEZONE).format('MMM D, YYYY HH:mm:ss')
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
  // Calculate performance stats
  const closedTrades = trades.filter(t => t.exit_price !== null)
  const winTrades = closedTrades.filter(t => t.win_loss === 'WIN')
  const lossTrades = closedTrades.filter(t => t.win_loss === 'LOSS')
  const totalPnL = closedTrades.reduce((sum, t) => sum + (t.net_pnl || 0), 0)
  const winRate = closedTrades.length > 0 ? (winTrades.length / closedTrades.length * 100).toFixed(1) : '0'
  const avgWin = winTrades.length > 0 ? winTrades.reduce((sum, t) => sum + (t.net_pnl || 0), 0) / winTrades.length : 0
  const avgLoss = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((sum, t) => sum + (t.net_pnl || 0), 0) / lossTrades.length) : 0
  const profitFactor = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'

  const tradeCards = trades
    .map(trade => {
      const rr = trade.target && trade.entry_price && trade.stop_loss
        ? Math.abs((trade.target - trade.entry_price) / (trade.entry_price - trade.stop_loss))
        : 0

      return `
    <div class="trade-card ${getStatusColor(trade)}">
      <div class="trade-header">
        <div class="trade-header-left">
          <span class="symbol">${trade.symbol}</span>
          <span class="trade-id">#${trade.id}</span>
          <span class="side-badge ${trade.side.toLowerCase()}">${trade.side}</span>
          <span class="status-badge ${trade.win_loss ? trade.win_loss.toLowerCase() : 'open'}">
            ${formatTradeStatus(trade)}
          </span>
        </div>
        <div class="trade-header-right">
          <span class="date">${trade.date ? dayjs.utc(trade.date).tz(DISPLAY_TIMEZONE).format('MMM D, YYYY') : 'Pending'}</span>
          <span class="time">${trade.time ? dayjs.utc(`${trade.date} ${trade.time}`).tz(DISPLAY_TIMEZONE).format('HH:mm:ss') : ''}</span>
        </div>
      </div>
      
      <div class="trade-body">
        <div class="trade-main-info">
          <div class="info-group">
            <div class="info-item">
              <span class="label">Entry</span>
              <span class="value">${formatPrice(trade.entry_price)}</span>
            </div>
            <div class="info-item">
              <span class="label">Stop Loss</span>
              <span class="value">${formatPrice(trade.stop_loss)}</span>
            </div>
            <div class="info-item">
              <span class="label">Target</span>
              <span class="value">${formatPrice(trade.target)}</span>
            </div>
            <div class="info-item">
              <span class="label">Size</span>
              <span class="value">${trade.qty}</span>
            </div>
            <div class="info-item">
              <span class="label">R:R</span>
              <span class="value">1:${rr.toFixed(2)}</span>
            </div>
          </div>
          
          ${trade.exit_price ? `
          <div class="info-group">
            <div class="info-item">
              <span class="label">Exit</span>
              <span class="value">${formatPrice(trade.exit_price)}</span>
            </div>
            <div class="info-item">
              <span class="label">Exit Time</span>
              <span class="value">${trade.exit_time ? dayjs.utc(trade.exit_time).tz(DISPLAY_TIMEZONE).format('HH:mm:ss') : 'N/A'}</span>
            </div>
            <div class="info-item">
              <span class="label">P&L</span>
              <span class="value ${trade.net_pnl && trade.net_pnl > 0 ? 'profit' : 'loss'}">${formatPnL(trade.net_pnl)}</span>
            </div>
            <div class="info-item">
              <span class="label">R-Multiple</span>
              <span class="value">${trade.r_multiple?.toFixed(2) || 'N/A'}</span>
            </div>
            <div class="info-item">
              <span class="label">Fees</span>
              <span class="value">${trade.fees.toFixed(2)}</span>
            </div>
          </div>
          ` : ''}
        </div>
        
        ${trade.market_context || trade.setup_type ? `
        <div class="trade-analysis">
          <h4>Analysis</h4>
          <div class="analysis-content">
            <div class="analysis-item">
              <span class="label">Setup</span>
              <span class="value">${trade.setup_type}</span>
            </div>
            ${trade.trend ? `
            <div class="analysis-item">
              <span class="label">Trend</span>
              <span class="value">${trade.trend}</span>
            </div>
            ` : ''}
            ${trade.confluence_factors ? `
            <div class="analysis-item">
              <span class="label">Confluence</span>
              <span class="value">${trade.confluence_factors}/5</span>
            </div>
            ` : ''}
            ${trade.risk_percent ? `
            <div class="analysis-item">
              <span class="label">Risk %</span>
              <span class="value">${trade.risk_percent}%</span>
            </div>
            ` : ''}
          </div>
          ${trade.market_context ? `
          <div class="context-text">
            <strong>Context:</strong> ${trade.market_context}
          </div>
          ` : ''}
          ${trade.entry_trigger ? `
          <div class="context-text">
            <strong>Trigger:</strong> ${trade.entry_trigger}
          </div>
          ` : ''}
        </div>
        ` : ''}
        
        ${trade.trade_grade || trade.exit_reason ? `
        <div class="trade-review">
          <h4>Review</h4>
          <div class="review-content">
            ${trade.trade_grade ? `
            <div class="review-item">
              <span class="label">Grade</span>
              <span class="value grade-${trade.trade_grade?.toLowerCase()}">${trade.trade_grade}</span>
            </div>
            ` : ''}
            ${trade.execution_quality ? `
            <div class="review-item">
              <span class="label">Execution</span>
              <span class="value">${trade.execution_quality}</span>
            </div>
            ` : ''}
            ${trade.emotional_state ? `
            <div class="review-item">
              <span class="label">Emotion</span>
              <span class="value">${trade.emotional_state}</span>
            </div>
            ` : ''}
            ${trade.followed_rules !== null ? `
            <div class="review-item">
              <span class="label">Rules</span>
              <span class="value">${trade.followed_rules ? '✓ Yes' : '✗ No'}</span>
            </div>
            ` : ''}
          </div>
          ${trade.exit_reason ? `
          <div class="context-text">
            <strong>Exit Reason:</strong> ${trade.exit_reason}
          </div>
          ` : ''}
          ${trade.mistakes ? `
          <div class="context-text">
            <strong>Mistakes:</strong> ${trade.mistakes}
          </div>
          ` : ''}
          ${trade.lessons ? `
          <div class="context-text">
            <strong>Lessons:</strong> ${trade.lessons}
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
  <title>Trading Journal - Professional Trading Analytics</title>
  <style>
    :root {
      /* TradingView Dark Theme Colors */
      --tv-color-platform-background: #131722;
      --tv-color-pane-background: #1e222d;
      --tv-color-toolbar-background: #2a2e39;
      --tv-color-success: #26a69a;
      --tv-color-success-hover: #22877a;
      --tv-color-danger: #ef5350;
      --tv-color-danger-hover: #b71c1c;
      --tv-color-warning: #ff9800;
      --tv-color-brand: #2962ff;
      --tv-color-brand-hover: #1e53e5;
      --tv-color-text-primary: #d1d4dc;
      --tv-color-text-secondary: #787b86;
      --tv-color-border: #363a45;
      --tv-color-input-background: #1e222d;
      --tv-color-popup-background: #2a2e39;
      --tv-color-popup-border: #363a45;
      --tv-color-item-hover-background: #2a2e39;
      --tv-color-item-selected-background: #142e61;
      --tv-color-scrollbar: #363a45;
      --tv-color-tooltip-background: #434651;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica Neue, sans-serif;
      background-color: var(--tv-color-platform-background);
      color: var(--tv-color-text-primary);
      line-height: 1.5;
      font-size: 14px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    
    .header {
      background-color: var(--tv-color-pane-background);
      border-bottom: 1px solid var(--tv-color-border);
      padding: 16px 0;
      position: sticky;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(10px);
    }
    
    .header-content {
      max-width: 1920px;
      margin: 0 auto;
      padding: 0 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo {
      font-size: 20px;
      font-weight: 600;
      color: var(--tv-color-text-primary);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .logo::before {
      content: "📊";
      font-size: 24px;
    }
    
    .stats-bar {
      display: flex;
      gap: 32px;
      align-items: center;
    }
    
    .stat-item {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }
    
    .stat-label {
      font-size: 11px;
      color: var(--tv-color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .stat-value {
      font-size: 16px;
      font-weight: 500;
      color: var(--tv-color-text-primary);
    }
    
    .stat-value.positive {
      color: var(--tv-color-success);
    }
    
    .stat-value.negative {
      color: var(--tv-color-danger);
    }
    
    .container {
      max-width: 1920px;
      margin: 0 auto;
      padding: 20px;
    }
    
    .trades-container {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(450px, 1fr));
      gap: 20px;
    }
    
    .trade-card {
      background-color: var(--tv-color-pane-background);
      border: 1px solid var(--tv-color-border);
      border-radius: 4px;
      overflow: hidden;
      transition: all 0.15s ease;
    }
    
    .trade-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    
    
    .trade-header {
      background-color: var(--tv-color-toolbar-background);
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--tv-color-border);
    }
    
    .trade-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .trade-header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--tv-color-text-secondary);
      font-size: 12px;
    }
    
    .symbol {
      font-size: 16px;
      font-weight: 600;
      color: var(--tv-color-text-primary);
    }
    
    .trade-id {
      color: var(--tv-color-text-secondary);
      font-size: 12px;
    }
    
    .side-badge {
      display: inline-flex;
      padding: 3px 8px;
      border-radius: 2px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .side-badge.long {
      background-color: rgba(38, 166, 154, 0.15);
      color: var(--tv-color-success);
    }
    
    .side-badge.short {
      background-color: rgba(239, 83, 80, 0.15);
      color: var(--tv-color-danger);
    }
    
    .status-badge {
      display: inline-flex;
      padding: 3px 8px;
      border-radius: 2px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .status-badge.win {
      background-color: rgba(38, 166, 154, 0.15);
      color: var(--tv-color-success);
    }
    
    .status-badge.loss {
      background-color: rgba(239, 83, 80, 0.15);
      color: var(--tv-color-danger);
    }
    
    .status-badge.be {
      background-color: rgba(255, 152, 0, 0.15);
      color: var(--tv-color-warning);
    }
    
    .status-badge.open {
      background-color: rgba(41, 98, 255, 0.15);
      color: var(--tv-color-brand);
    }
    
    .trade-body {
      padding: 16px;
    }
    
    .trade-main-info {
      display: flex;
      gap: 24px;
      margin-bottom: 16px;
    }
    
    .info-group {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      flex: 1;
    }
    
    .info-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 80px;
    }
    
    .info-item .label {
      font-size: 11px;
      color: var(--tv-color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .info-item .value {
      font-size: 14px;
      color: var(--tv-color-text-primary);
      font-weight: 500;
      font-family: Roboto Mono, monospace;
    }
    
    .info-item .value.profit {
      color: var(--tv-color-success);
    }
    
    .info-item .value.loss {
      color: var(--tv-color-danger);
    }
    
    .trade-analysis,
    .trade-review {
      background-color: var(--tv-color-platform-background);
      border: 1px solid var(--tv-color-border);
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 12px;
    }
    
    .trade-analysis:last-child,
    .trade-review:last-child {
      margin-bottom: 0;
    }
    
    .trade-analysis h4,
    .trade-review h4 {
      font-size: 12px;
      font-weight: 600;
      color: var(--tv-color-text-primary);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .analysis-content,
    .review-content {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 8px;
    }
    
    .analysis-item,
    .review-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .analysis-item .label,
    .review-item .label {
      font-size: 11px;
      color: var(--tv-color-text-secondary);
    }
    
    .analysis-item .value,
    .review-item .value {
      font-size: 12px;
      color: var(--tv-color-text-primary);
      font-weight: 500;
    }
    
    .value.grade-a {
      color: var(--tv-color-success);
    }
    
    .value.grade-b {
      color: #66bb6a;
    }
    
    .value.grade-c {
      color: var(--tv-color-warning);
    }
    
    .value.grade-d,
    .value.grade-f {
      color: var(--tv-color-danger);
    }
    
    .context-text {
      font-size: 12px;
      line-height: 1.5;
      color: var(--tv-color-text-secondary);
      margin-top: 8px;
    }
    
    .context-text strong {
      color: var(--tv-color-text-primary);
      font-weight: 500;
    }
    
    .empty-state-container {
      background-color: var(--tv-color-pane-background);
      border: 1px solid var(--tv-color-border);
      border-radius: 4px;
      padding: 60px 20px;
    }
    
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      color: var(--tv-color-text-secondary);
    }
    
    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }
    
    .empty-state-title {
      font-size: 18px;
      margin-bottom: 8px;
      color: var(--tv-color-text-primary);
    }
    
    .empty-state-description {
      font-size: 14px;
    }
    
    /* Scrollbar styling */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    
    ::-webkit-scrollbar-track {
      background: var(--tv-color-pane-background);
    }
    
    ::-webkit-scrollbar-thumb {
      background: var(--tv-color-scrollbar);
      border-radius: 4px;
    }
    
    ::-webkit-scrollbar-thumb:hover {
      background: var(--tv-color-text-secondary);
    }
    
    @media (max-width: 768px) {
      .header-content {
        flex-direction: column;
        gap: 16px;
      }
      
      .stats-bar {
        width: 100%;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      
      .stat-item {
        align-items: center;
      }
      
      .container {
        padding: 12px;
      }
      
      .trades-container {
        grid-template-columns: 1fr;
      }
      
      .trade-card {
        margin: 0;
      }
      
      .trade-main-info {
        flex-direction: column;
        gap: 16px;
      }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-content">
      <div class="logo">Trading Journal <span style="font-size: 12px; color: var(--tv-color-text-secondary); font-weight: 400;">(UTC+8)</span></div>
      <div class="stats-bar">
        <div class="stat-item">
          <span class="stat-label">Total Trades</span>
          <span class="stat-value">${trades.length}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Win Rate</span>
          <span class="stat-value">${winRate}%</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Total P&L</span>
          <span class="stat-value ${totalPnL >= 0 ? 'positive' : 'negative'}">${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Profit Factor</span>
          <span class="stat-value">${profitFactor}</span>
        </div>
      </div>
    </div>
  </header>
  
  <div class="container">
    ${trades.length > 0 ? `
      <div class="trades-container">
        ${tradeCards}
      </div>
    ` : `
      <div class="empty-state-container">
        <div class="empty-state">
          <div class="empty-state-icon">📊</div>
          <h2 class="empty-state-title">No trades yet</h2>
          <p class="empty-state-description">Start trading to see your journal entries here</p>
        </div>
      </div>
    `}
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