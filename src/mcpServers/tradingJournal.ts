#!/usr/bin/env -S npx tsx
import { db } from '@/database'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js'
import { type Database } from 'better-sqlite3'

interface Trade {
  id: number
  date: string
  time: string
  symbol: string
  setup_type: string
  side: 'LONG' | 'SHORT'
  qty: number
  entry_price: number
  stop_loss: number
  target: number
  exit_price?: number
  exit_time?: string
  pnl?: number
  r_multiple?: number
  fees: number
  net_pnl?: number
  market_context?: string
  trend?: string
  key_levels?: string
  entry_trigger?: string
  risk_percent?: number
  position_size_rationale?: string
  confluence_factors?: number
  exit_reason?: string
  trade_grade?: string
  execution_quality?: string
  mistakes?: string
  lessons?: string
  emotional_state?: string
  followed_rules?: boolean
  account_balance?: number
  win_loss?: 'WIN' | 'LOSS' | 'BE'
  cumulative_pnl?: number
  win_rate?: number
  avg_win?: number
  avg_loss?: number
  max_drawdown?: number
  created_at: string
  updated_at: string
}

interface AddPreTradeAnalysisArgs {
  symbol: string
  setup_type: string
  side: 'LONG' | 'SHORT'
  qty: number
  entry_price: number
  stop_loss: number
  target: number
  market_context: string
  trend: string
  key_levels: string
  entry_trigger: string
  risk_percent: number
  position_size_rationale: string
  confluence_factors: number
}

interface AddTradeEntryArgs {
  trade_id: number
  date: string
  time: string
  actual_entry_price: number
  fees: number
}

interface UpdateTradeExitArgs {
  trade_id: number
  exit_price: number
  exit_time: string
  fees: number
  exit_reason: string
  account_balance?: number
}

interface AddPostTradeReviewArgs {
  trade_id: number
  trade_grade: string
  execution_quality: string
  mistakes?: string
  lessons?: string
  emotional_state: string
  followed_rules: boolean
}

interface ListTradesArgs {
  last_n?: number
  symbol?: string
  setup_type?: string
  from_date?: string
  to_date?: string
}

const tradingJournalTools: Tool[] = [
  {
    name: 'add_pre_trade_analysis',
    description: 'Add pre-trade analysis for a new trade setup',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading symbol (e.g., ETHUSDC)' },
        setup_type: { type: 'string', description: 'Setup type (breakout, reversal, momentum, etc.)' },
        side: { type: 'string', enum: ['LONG', 'SHORT'], description: 'Trade direction' },
        qty: { type: 'number', description: 'Position size' },
        entry_price: { type: 'number', description: 'Planned entry price' },
        stop_loss: { type: 'number', description: 'Stop loss price' },
        target: { type: 'number', description: 'Target price' },
        market_context: { type: 'string', description: 'Overall market conditions' },
        trend: { type: 'string', description: 'Current trend analysis' },
        key_levels: { type: 'string', description: 'Important support/resistance levels' },
        entry_trigger: { type: 'string', description: 'Specific trigger for entry' },
        risk_percent: { type: 'number', description: 'Risk percentage of account' },
        position_size_rationale: { type: 'string', description: 'Reasoning for position size' },
        confluence_factors: { type: 'number', description: 'Number of confluence factors (1-5)' }
      },
      required: ['symbol', 'setup_type', 'side', 'qty', 'entry_price', 'stop_loss', 'target', 
                 'market_context', 'trend', 'key_levels', 'entry_trigger', 'risk_percent', 
                 'position_size_rationale', 'confluence_factors']
    }
  },
  {
    name: 'add_trade_entry',
    description: 'Record actual trade entry details',
    inputSchema: {
      type: 'object',
      properties: {
        trade_id: { type: 'number', description: 'Trade ID from pre-trade analysis' },
        date: { type: 'string', description: 'Entry date (YYYY-MM-DD)' },
        time: { type: 'string', description: 'Entry time (HH:MM:SS)' },
        actual_entry_price: { type: 'number', description: 'Actual entry price executed' },
        fees: { type: 'number', description: 'Entry fees' }
      },
      required: ['trade_id', 'date', 'time', 'actual_entry_price', 'fees']
    }
  },
  {
    name: 'update_trade_exit',
    description: 'Update trade with exit details',
    inputSchema: {
      type: 'object',
      properties: {
        trade_id: { type: 'number', description: 'Trade ID to update' },
        exit_price: { type: 'number', description: 'Exit price' },
        exit_time: { type: 'string', description: 'Exit time (YYYY-MM-DD HH:MM:SS)' },
        fees: { type: 'number', description: 'Exit fees' },
        exit_reason: { type: 'string', description: 'Reason for exit (TP hit, SL hit, manual exit, etc.)' },
        account_balance: { type: 'number', description: 'Account balance after trade completion (optional)' }
      },
      required: ['trade_id', 'exit_price', 'exit_time', 'fees', 'exit_reason']
    }
  },
  {
    name: 'add_post_trade_review',
    description: 'Add post-trade review and analysis',
    inputSchema: {
      type: 'object',
      properties: {
        trade_id: { type: 'number', description: 'Trade ID to review' },
        trade_grade: { type: 'string', description: 'Trade grade (A-F)' },
        execution_quality: { type: 'string', description: 'Quality of execution' },
        mistakes: { type: 'string', description: 'Mistakes made (optional)' },
        lessons: { type: 'string', description: 'Lessons learned (optional)' },
        emotional_state: { type: 'string', description: 'Emotional state (Calm/Anxious/FOMO/Confident/Fearful)' },
        followed_rules: { type: 'boolean', description: 'Whether trading rules were followed' }
      },
      required: ['trade_id', 'trade_grade', 'execution_quality', 'emotional_state', 'followed_rules']
    }
  },
  {
    name: 'list_trades',
    description: 'List trades in compact CSV format for maximum token efficiency',
    inputSchema: {
      type: 'object',
      properties: {
        last_n: { type: 'number', description: 'Number of recent trades (default: 20)' },
        symbol: { type: 'string', description: 'Filter by symbol' },
        setup_type: { type: 'string', description: 'Filter by setup type' },
        from_date: { type: 'string', description: 'Filter from date (YYYY-MM-DD)' },
        to_date: { type: 'string', description: 'Filter to date (YYYY-MM-DD)' }
      }
    }
  },
  {
    name: 'get_trade_details',
    description: 'Get full details of a specific trade',
    inputSchema: {
      type: 'object',
      properties: {
        trade_id: { type: 'number', description: 'Trade ID to retrieve' }
      },
      required: ['trade_id']
    }
  },
  {
    name: 'get_performance_stats',
    description: 'Get overall trading performance statistics',
    inputSchema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to_date: { type: 'string', description: 'End date (YYYY-MM-DD)' }
      }
    }
  }
]

class TradingJournalDatabase {
  constructor(private db: Database = db) {
    this.db = db
    this.initDatabase()
  }

  private initDatabase() {
    this.db.exec(`
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

    // Create index for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(date);
      CREATE INDEX IF NOT EXISTS idx_trades_setup_type ON trades(setup_type);
    `)
  }

  addPreTradeAnalysis(args: AddPreTradeAnalysisArgs): Trade {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        symbol, setup_type, side, qty, entry_price, stop_loss, target,
        market_context, trend, key_levels, entry_trigger, risk_percent,
        position_size_rationale, confluence_factors
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    const result = stmt.run(
      args.symbol, args.setup_type, args.side, args.qty, args.entry_price,
      args.stop_loss, args.target, args.market_context, args.trend,
      args.key_levels, args.entry_trigger, args.risk_percent,
      args.position_size_rationale, args.confluence_factors
    )

    const trade = this.db
      .prepare('SELECT * FROM trades WHERE id = ?')
      .get(result.lastInsertRowid) as Trade

    return trade
  }

  addTradeEntry(tradeId: number, date: string, time: string, actualEntryPrice: number, fees: number): Trade {
    const trade = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) as Trade
    if (!trade) throw new Error(`Trade ${tradeId} not found`)

    const stmt = this.db.prepare(`
      UPDATE trades 
      SET date = ?, time = ?, entry_price = ?, fees = fees + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    
    stmt.run(date, time, actualEntryPrice, fees, tradeId)

    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) as Trade
  }

  updateTradeExit(tradeId: number, exitPrice: number, exitTime: string, fees: number, exitReason: string, accountBalance?: number): Trade {
    const trade = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) as Trade
    if (!trade) throw new Error(`Trade ${tradeId} not found`)

    // Calculate P&L and R-multiple
    const risk = Math.abs(trade.entry_price - trade.stop_loss)
    const grossPnl = trade.side === 'LONG' 
      ? (exitPrice - trade.entry_price) * trade.qty
      : (trade.entry_price - exitPrice) * trade.qty
    const totalFees = (trade.fees || 0) + fees
    const netPnl = grossPnl - totalFees
    const rMultiple = risk > 0 ? (grossPnl / trade.qty) / risk : 0
    const winLoss = netPnl > 0 ? 'WIN' : netPnl < 0 ? 'LOSS' : 'BE'

    const stmt = this.db.prepare(`
      UPDATE trades 
      SET exit_price = ?, exit_time = ?, pnl = ?, r_multiple = ?, 
          fees = ?, net_pnl = ?, exit_reason = ?, win_loss = ?, 
          account_balance = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    
    stmt.run(exitPrice, exitTime, grossPnl, rMultiple, totalFees, netPnl, exitReason, winLoss, accountBalance || null, tradeId)

    // Update performance stats
    this.updatePerformanceStats()

    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) as Trade
  }

  addPostTradeReview(args: AddPostTradeReviewArgs): Trade {
    const trade = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(args.trade_id) as Trade
    if (!trade) throw new Error(`Trade ${args.trade_id} not found`)

    const stmt = this.db.prepare(`
      UPDATE trades 
      SET trade_grade = ?, execution_quality = ?, mistakes = ?, 
          lessons = ?, emotional_state = ?, followed_rules = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    
    stmt.run(
      args.trade_grade, args.execution_quality, args.mistakes || null,
      args.lessons || null, args.emotional_state, args.followed_rules ? 1 : 0,
      args.trade_id
    )

    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(args.trade_id) as Trade
  }

  listTrades(args: ListTradesArgs): Trade[] {
    let query = 'SELECT * FROM trades WHERE 1=1'
    const params: any[] = []

    if (args.symbol) {
      query += ' AND symbol = ?'
      params.push(args.symbol)
    }
    if (args.setup_type) {
      query += ' AND setup_type = ?'
      params.push(args.setup_type)
    }
    if (args.from_date) {
      query += ' AND date >= ?'
      params.push(args.from_date)
    }
    if (args.to_date) {
      query += ' AND date <= ?'
      params.push(args.to_date)
    }

    query += ' ORDER BY id DESC'
    
    // Default to 20 trades if no limit specified
    const limit = args.last_n || 20
    query += ' LIMIT ?'
    params.push(limit)

    const stmt = this.db.prepare(query)
    return stmt.all(...params) as Trade[]
  }

  getTrade(tradeId: number): Trade | undefined {
    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) as Trade
  }

  getPerformanceStats(fromDate?: string, toDate?: string) {
    let query = 'SELECT * FROM trades WHERE exit_price IS NOT NULL'
    const params: any[] = []

    if (fromDate) {
      query += ' AND date >= ?'
      params.push(fromDate)
    }
    if (toDate) {
      query += ' AND date <= ?'
      params.push(toDate)
    }

    const trades = this.db.prepare(query).all(...params) as Trade[]
    
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        totalPnl: 0,
        avgRMultiple: 0,
        maxDrawdown: 0
      }
    }

    const wins = trades.filter(t => t.win_loss === 'WIN')
    const losses = trades.filter(t => t.win_loss === 'LOSS')
    const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + (t.net_pnl || 0), 0) / wins.length : 0
    const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + (t.net_pnl || 0), 0) / losses.length : 0
    const totalPnl = trades.reduce((sum, t) => sum + (t.net_pnl || 0), 0)
    const avgRMultiple = trades.reduce((sum, t) => sum + (t.r_multiple || 0), 0) / trades.length

    // Calculate max drawdown
    let maxDrawdown = 0
    let peak = 0
    let runningPnl = 0
    
    for (const trade of trades) {
      runningPnl += trade.net_pnl || 0
      if (runningPnl > peak) peak = runningPnl
      const drawdown = peak - runningPnl
      if (drawdown > maxDrawdown) maxDrawdown = drawdown
    }

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: trades.filter(t => t.win_loss === 'BE').length,
      winRate: (wins.length / trades.length) * 100,
      avgWin,
      avgLoss,
      profitFactor: Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0,
      totalPnl,
      avgRMultiple,
      maxDrawdown
    }
  }

  private updatePerformanceStats() {
    // This would update cumulative stats on the latest trade
    // For simplicity, we'll calculate them on demand in getPerformanceStats
  }

  close() {
    this.db.close()
  }
}

const journalDb = new TradingJournalDatabase(db)

const server = new Server(
  {
    name: 'trading-journal-server',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tradingJournalTools
  }
})

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'add_pre_trade_analysis': {
      const analysisArgs = args as unknown as AddPreTradeAnalysisArgs
      try {
        const trade = journalDb.addPreTradeAnalysis(analysisArgs)
        return {
          content: [{
            type: 'text',
            text: `Pre-trade analysis added:\nTrade ID: ${trade.id}\nSymbol: ${trade.symbol}\nSetup: ${trade.setup_type}\nSide: ${trade.side}\nEntry: ${trade.entry_price}\nStop: ${trade.stop_loss}\nTarget: ${trade.target}\nRisk/Reward: 1:${((trade.target - trade.entry_price) / (trade.entry_price - trade.stop_loss)).toFixed(2)}`
          }]
        }
      } catch (error) {
        throw new Error(`Failed to add pre-trade analysis: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    case 'add_trade_entry': {
      const entryArgs = args as unknown as AddTradeEntryArgs
      try {
        const trade = journalDb.addTradeEntry(
          entryArgs.trade_id,
          entryArgs.date,
          entryArgs.time,
          entryArgs.actual_entry_price,
          entryArgs.fees
        )
        return {
          content: [{
            type: 'text',
            text: `Trade entry recorded:\nTrade ID: ${trade.id}\nEntry: ${trade.entry_price}\nDate/Time: ${trade.date} ${trade.time}\nFees: ${entryArgs.fees}`
          }]
        }
      } catch (error) {
        throw new Error(`Failed to record trade entry: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    case 'update_trade_exit': {
      const exitArgs = args as unknown as UpdateTradeExitArgs
      try {
        const trade = journalDb.updateTradeExit(
          exitArgs.trade_id,
          exitArgs.exit_price,
          exitArgs.exit_time,
          exitArgs.fees,
          exitArgs.exit_reason,
          exitArgs.account_balance
        )
        return {
          content: [{
            type: 'text',
            text: `Trade exit updated:\nTrade ID: ${trade.id}\nExit: ${trade.exit_price}\nP&L: ${trade.pnl?.toFixed(2)}\nNet P&L: ${trade.net_pnl?.toFixed(2)}\nR-Multiple: ${trade.r_multiple?.toFixed(2)}\nResult: ${trade.win_loss}${trade.account_balance ? `\nAccount Balance: ${trade.account_balance.toFixed(2)}` : ''}`
          }]
        }
      } catch (error) {
        throw new Error(`Failed to update trade exit: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    case 'add_post_trade_review': {
      const reviewArgs = args as unknown as AddPostTradeReviewArgs
      try {
        const trade = journalDb.addPostTradeReview(reviewArgs)
        return {
          content: [{
            type: 'text',
            text: `Post-trade review added:\nTrade ID: ${trade.id}\nGrade: ${trade.trade_grade}\nExecution: ${trade.execution_quality}\nEmotional State: ${trade.emotional_state}\nFollowed Rules: ${trade.followed_rules ? 'Yes' : 'No'}`
          }]
        }
      } catch (error) {
        throw new Error(`Failed to add post-trade review: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    case 'list_trades': {
      const listArgs = (args || {}) as ListTradesArgs
      try {
        const trades = journalDb.listTrades({ last_n: 20, ...listArgs })
        
        if (trades.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'trades: []'
            }]
          }
        }

        // Convert to compact CSV format with all columns
        const csvHeader = 'id,date,time,symbol,setup_type,side,qty,entry_price,stop_loss,target,exit_price,exit_time,pnl,r_multiple,fees,net_pnl,market_context,trend,key_levels,entry_trigger,risk_percent,position_size_rationale,confluence_factors,exit_reason,trade_grade,execution_quality,mistakes,lessons,emotional_state,followed_rules,account_balance,win_loss,cumulative_pnl,win_rate,avg_win,avg_loss,max_drawdown,created_at,updated_at'
        const csvRows = trades.map(trade => {
          return [
            trade.id,
            trade.date || '',
            trade.time || '',
            trade.symbol,
            trade.setup_type,
            trade.side,
            trade.qty,
            trade.entry_price,
            trade.stop_loss,
            trade.target,
            trade.exit_price || '',
            trade.exit_time || '',
            trade.pnl || '',
            trade.r_multiple || '',
            trade.fees,
            trade.net_pnl || '',
            trade.market_context || '',
            trade.trend || '',
            trade.key_levels || '',
            trade.entry_trigger || '',
            trade.risk_percent || '',
            trade.position_size_rationale || '',
            trade.confluence_factors || '',
            trade.exit_reason || '',
            trade.trade_grade || '',
            trade.execution_quality || '',
            trade.mistakes || '',
            trade.lessons || '',
            trade.emotional_state || '',
            trade.followed_rules !== null ? trade.followed_rules : '',
            trade.account_balance || '',
            trade.win_loss || '',
            trade.cumulative_pnl || '',
            trade.win_rate || '',
            trade.avg_win || '',
            trade.avg_loss || '',
            trade.max_drawdown || '',
            trade.created_at,
            trade.updated_at
          ].map(val => {
            // Escape commas and quotes in CSV values
            if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
              return `"${val.replace(/"/g, '""')}"`
            }
            return val
          }).join(',')
        })

        const csvOutput = `${csvHeader}\n${csvRows.join('\n')}`

        return {
          content: [{
            type: 'text',
            text: csvOutput
          }]
        }
      } catch (error) {
        throw new Error(`Failed to list trades: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    case 'get_trade_details': {
      const { trade_id } = args as { trade_id: number }
      try {
        const trade = journalDb.getTrade(trade_id)
        if (!trade) {
          return {
            content: [{
              type: 'text',
              text: `Trade ${trade_id} not found`
            }]
          }
        }

        const details = `Trade Details #${trade.id}
===================
BASIC INFO:
Date/Time: ${trade.date || 'Planned'} ${trade.time || ''}
Symbol: ${trade.symbol} | Side: ${trade.side} | Setup: ${trade.setup_type}
Quantity: ${trade.qty}

PRICES:
Entry: ${trade.entry_price} | Stop: ${trade.stop_loss} | Target: ${trade.target}
Exit: ${trade.exit_price || 'Open'} | Exit Time: ${trade.exit_time || 'N/A'}

PERFORMANCE:
P&L: ${trade.pnl?.toFixed(2) || 'N/A'} | Fees: ${trade.fees}
Net P&L: ${trade.net_pnl?.toFixed(2) || 'N/A'} | R-Multiple: ${trade.r_multiple?.toFixed(2) || 'N/A'}
Result: ${trade.win_loss || 'Open'}

PRE-TRADE ANALYSIS:
Market Context: ${trade.market_context || 'N/A'}
Trend: ${trade.trend || 'N/A'}
Key Levels: ${trade.key_levels || 'N/A'}
Entry Trigger: ${trade.entry_trigger || 'N/A'}
Risk %: ${trade.risk_percent || 'N/A'}
Position Size Rationale: ${trade.position_size_rationale || 'N/A'}
Confluence Factors: ${trade.confluence_factors || 'N/A'}

POST-TRADE REVIEW:
Exit Reason: ${trade.exit_reason || 'N/A'}
Grade: ${trade.trade_grade || 'N/A'} | Execution: ${trade.execution_quality || 'N/A'}
Emotional State: ${trade.emotional_state || 'N/A'}
Followed Rules: ${trade.followed_rules !== null ? (trade.followed_rules ? 'Yes' : 'No') : 'N/A'}
Mistakes: ${trade.mistakes || 'None noted'}
Lessons: ${trade.lessons || 'None noted'}`

        return {
          content: [{
            type: 'text',
            text: details
          }]
        }
      } catch (error) {
        throw new Error(`Failed to get trade details: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    case 'get_performance_stats': {
      const { from_date, to_date } = (args || {}) as { from_date?: string; to_date?: string }
      try {
        const stats = journalDb.getPerformanceStats(from_date, to_date)
        
        const statsText = `Performance Statistics
=====================
Period: ${from_date || 'All time'} to ${to_date || 'Present'}

Total Trades: ${stats.totalTrades}
Wins: ${stats.wins} | Losses: ${stats.losses} | Breakeven: ${stats.breakeven}
Win Rate: ${stats.winRate.toFixed(2)}%

Average Win: ${stats.avgWin.toFixed(2)}
Average Loss: ${stats.avgLoss.toFixed(2)}
Profit Factor: ${stats.profitFactor.toFixed(2)}

Total P&L: ${stats.totalPnl.toFixed(2)}
Average R-Multiple: ${stats.avgRMultiple.toFixed(2)}
Max Drawdown: ${stats.maxDrawdown.toFixed(2)}`

        return {
          content: [{
            type: 'text',
            text: statsText
          }]
        }
      } catch (error) {
        throw new Error(`Failed to get performance stats: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

process.on('SIGINT', () => {
  journalDb.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  journalDb.close()
  process.exit(0)
})

main().catch(() => {
  journalDb.close()
  process.exit(1)
})