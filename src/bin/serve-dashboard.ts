#!/usr/bin/env node

/**
 * Trading Dashboard - serves memo data and trading system with revision history
 * It renders all memos and trading system as a modern responsive web ui.
 */

import { db } from '@/database'
import { logger } from '@/utils/logger'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import fs from 'fs'
import path from 'path'
import { diffLines } from 'diff'

interface Memo {
  id: number
  date: string
  content: string
  created_at: string
}

interface TradingSystem {
  id: number
  created_time: string
  revision: number
  content: string
  revision_notes: string | null
}

const PORT = 3001

// Basic auth credentials
const AUTH_USERNAME = 'trading-system'
const AUTH_PASSWORD = 'xLtG4skauX4kk8yb4AEz'

function parseBasicAuth(authHeader: string): { username: string; password: string } | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null
  }
  
  try {
    const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const [username, password] = credentials.split(':')
    return { username, password }
  } catch {
    return null
  }
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const authHeader = req.headers.authorization
  const credentials = parseBasicAuth(authHeader || '')
  
  if (!credentials || credentials.username !== AUTH_USERNAME || credentials.password !== AUTH_PASSWORD) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Trading Dashboard"',
      'Content-Type': 'text/plain'
    })
    res.end('Authentication required')
    return false
  }
  
  return true
}

// Initialize trading systems table
db.exec(`
  CREATE TABLE IF NOT EXISTS trading_systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_time TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    revision_notes TEXT
  )
`)

// Initialize trading system if empty
const getInitialTradingSystem = (): string => {
  try {
    const tradingSystemPath = path.join(process.cwd(), 'src', 'tradingSystem', 'tradingSystem.md')
    if (fs.existsSync(tradingSystemPath)) {
      return fs.readFileSync(tradingSystemPath, 'utf-8')
    }
  } catch (error) {
    // Ignore errors
  }
  return `# Trading System

Initial trading system content. Please update with your trading rules and strategies.`
}

const countStmt = db.prepare('SELECT COUNT(*) as count FROM trading_systems')
const count = countStmt.get() as { count: number }
if (count.count === 0) {
  const insertStmt = db.prepare(`
    INSERT INTO trading_systems (created_time, revision, content, revision_notes)
    VALUES (?, ?, ?, ?)
  `)
  insertStmt.run(
    new Date().toISOString(),
    1,
    getInitialTradingSystem(),
    'Initial trading system'
  )
}

// Prepare statements for better performance
const getAllMemosStmt = db.prepare(`
  SELECT id, date, content, created_at 
  FROM memos 
  ORDER BY date DESC, created_at DESC
`)

const getMemosWithLimitStmt = db.prepare(`
  SELECT id, date, content, created_at 
  FROM memos 
  ORDER BY date DESC, created_at DESC 
  LIMIT ?
`)

function getMemos(limit?: number): Memo[] {
  try {
    if (limit) {
      return getMemosWithLimitStmt.all(limit) as Memo[]
    }
    return getAllMemosStmt.all() as Memo[]
  } catch (error) {
    logger.error({ error }, 'Database error')
    return []
  }
}

// Trading system query functions
const getLatestTradingSystemStmt = db.prepare(`
  SELECT created_time, revision, content, revision_notes
  FROM trading_systems
  ORDER BY revision DESC
  LIMIT 1
`)

const getTradingSystemHistoryStmt = db.prepare(`
  SELECT created_time, revision, content, revision_notes
  FROM trading_systems
  ORDER BY revision DESC
  LIMIT ?
`)

function getLatestTradingSystem(): TradingSystem | null {
  try {
    return getLatestTradingSystemStmt.get() as TradingSystem | null
  } catch (error) {
    logger.error({ error }, 'Database error getting trading system')
    return null
  }
}

function getTradingSystemHistory(limit: number = 10): any[] {
  try {
    const revisions = getTradingSystemHistoryStmt.all(limit) as TradingSystem[]
    
    // Calculate diffs
    const history = []
    for (let i = 0; i < revisions.length; i++) {
      const current = revisions[i]
      const previous = i < revisions.length - 1 ? revisions[i + 1] : null
      
      let diffInfo = null
      if (previous) {
        // Check if this is a revert
        const isRevert = current.revision_notes?.includes('Reverted to revision')
        if (isRevert) {
          const match = current.revision_notes?.match(/Reverted to revision (\d+)/)
          if (match) {
            diffInfo = {
              type: 'revert',
              reverted_to: parseInt(match[1])
            }
          }
        } else {
          // Generate standard unified diff patch
          const diff = diffLines(previous.content, current.content)
          
          // Create unified diff format
          const diffPatch = []
          
          let oldLineNum = 1
          let newLineNum = 1
          let additions = 0
          let deletions = 0
          
          // Process diff parts to create proper unified diff
          for (const part of diff) {
            const lines = part.value.split('\n')
            if (lines[lines.length - 1] === '') {
              lines.pop() // Remove empty line from split
            }
            
            if (part.removed) {
              deletions += lines.length
              for (const line of lines) {
                diffPatch.push(`-${line}`)
                oldLineNum++
              }
            } else if (part.added) {
              additions += lines.length
              for (const line of lines) {
                diffPatch.push(`+${line}`)
                newLineNum++
              }
            } else {
              // Context lines
              for (const line of lines) {
                diffPatch.push(` ${line}`)
                oldLineNum++
                newLineNum++
              }
            }
          }
          
          diffInfo = {
            type: 'patch',
            additions,
            deletions,
            patch: diffPatch.join('\n')
          }
        }
      }
      
      history.push({
        created_time: current.created_time,
        revision: current.revision,
        revision_notes: current.revision_notes || '',
        diff: diffInfo
      })
    }
    
    return history
  } catch (error) {
    logger.error({ error }, 'Database error getting trading system history')
    return []
  }
}

function formatMemoContent(content: string): string {
  // Trim whitespace and convert memo content to HTML with line breaks and bold labels
  return content
    .trim()
    .split('\n')
    .map(line => line.trimStart()) // Remove leading whitespace from each line
    .join('\n')
    .replace(/\n/g, '<br>')
    .replace(/===/g, '<hr>')
    .replace(
      /(^|<br>)(KEY INSIGHT|DECISION|RATIONALE|RISK|BAL|RSK|POS|ACTIVE|ANALYSIS|BTC|ETH|S\/R|SETUP|TOOLS|Account|Positions|Open Orders|Action|Watch|ToolCalls|Decisions):/g,
      '$1<strong>$2:</strong>'
    )
}

function formatDateTime(dateStr: string): string {
  try {
    // The dateStr is in format "YYYY-MM-DD HH:MM:SS" and represents UTC time
    // Convert to UTC+8 timezone
    const utcDate = new Date(dateStr + 'Z')
    const utc8Date = new Date(utcDate.getTime())
    return utc8Date.toLocaleString('en-US', { timeZone: 'UTC' })
  } catch {
    return dateStr
  }
}

function renderHTML(memos: Memo[]): string {
  const memoCards = memos
    .map(
      memo => `
    <div class="memo-card" data-memo-id="${memo.id}">
      <div class="memo-header">
        <div class="memo-header-left">
          <div class="memo-id">Memo #${memo.id}</div>
          <div class="memo-date">${formatDateTime(memo.date)}</div>
        </div>
        <button class="copy-btn" onclick="copyMemo(${memo.id}, this)">
          📋 Copy
        </button>
      </div>
      <div class="memo-content">
        ${formatMemoContent(memo.content)}
      </div>
      <textarea class="memo-raw-content" style="display: none;">${memo.content}</textarea>
    </div>
  `
    )
    .join('')

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trading Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap" rel="stylesheet">
  <style>
    :root {
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 222.2 84% 4.9%;
      --primary: 221.2 83.2% 53.3%;
      --primary-foreground: 210 40% 98%;
      --secondary: 210 40% 96%;
      --secondary-foreground: 222.2 84% 4.9%;
      --muted: 210 40% 96%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --accent: 210 40% 96%;
      --accent-foreground: 222.2 84% 4.9%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 210 40% 98%;
      --border: 214.3 31.8% 91.4%;
      --input: 214.3 31.8% 91.4%;
      --ring: 221.2 83.2% 53.3%;
      --radius: 0.5rem;
    }

    .dark {
      --background: 222.2 84% 4.9%;
      --foreground: 210 40% 98%;
      --card: 222.2 84% 4.9%;
      --card-foreground: 210 40% 98%;
      --popover: 222.2 84% 4.9%;
      --popover-foreground: 210 40% 98%;
      --primary: 217.2 91.2% 59.8%;
      --primary-foreground: 222.2 84% 4.9%;
      --secondary: 217.2 32.6% 17.5%;
      --secondary-foreground: 210 40% 98%;
      --muted: 217.2 32.6% 17.5%;
      --muted-foreground: 215 20.2% 65.1%;
      --accent: 217.2 32.6% 17.5%;
      --accent-foreground: 210 40% 98%;
      --destructive: 0 62.8% 30.6%;
      --destructive-foreground: 210 40% 98%;
      --border: 217.2 32.6% 17.5%;
      --input: 217.2 32.6% 17.5%;
      --ring: 224.3 76.3% 94.1%;
    }

    * {
      border-color: hsl(var(--border));
    }

    body {
      background-color: hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.5;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    *, *:before, *:after {
      box-sizing: inherit;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem 1rem;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      margin-bottom: 2rem;
      align-items: center;
      justify-content: flex-end;
    }

    .controls-group {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
      border-radius: calc(var(--radius) - 2px);
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 0.2s ease;
      border: 1px solid hsl(var(--border));
      background-color: hsl(var(--background));
      color: hsl(var(--foreground));
      padding: 0.5rem 1rem;
      height: 2.5rem;
      cursor: pointer;
    }

    .btn:hover {
      background-color: hsl(var(--accent));
      color: hsl(var(--accent-foreground));
    }

    .btn-primary {
      background-color: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      border-color: hsl(var(--primary));
    }

    .btn-primary:hover {
      background-color: hsl(var(--primary) / 0.9);
    }

    .reload-btn {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      z-index: 1000;
      box-shadow: 0 4px 12px 0 rgb(0 0 0 / 0.15);
    }

    .reload-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px 0 rgb(0 0 0 / 0.2);
    }

    .memo-grid {
      display: grid;
      gap: 1.5rem;
      grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
    }

    .memo-card {
      background-color: hsl(var(--card));
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      overflow: hidden;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
    }

    .memo-card:hover {
      box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
      transform: translateY(-1px);
    }

    .memo-header {
      background-color: hsl(var(--muted) / 0.5);
      border-bottom: 1px solid hsl(var(--border));
      padding: 1rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }

    .memo-header-left {
      flex: 1;
    }

    .copy-btn {
      background: none;
      border: 1px solid hsl(var(--border));
      color: hsl(var(--muted-foreground));
      cursor: pointer;
      padding: 0.5rem;
      border-radius: calc(var(--radius) / 2);
      transition: all 0.2s ease;
      font-size: 0.875rem;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .copy-btn:hover {
      background-color: hsl(var(--accent));
      color: hsl(var(--accent-foreground));
      border-color: hsl(var(--accent));
    }

    .copy-btn.copied {
      background-color: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      border-color: hsl(var(--primary));
    }

    .memo-id {
      font-size: 1.125rem;
      font-weight: 600;
      color: hsl(var(--primary));
      margin-bottom: 0.25rem;
    }

    .memo-date {
      font-size: 0.875rem;
      color: hsl(var(--foreground));
      margin-bottom: 0.25rem;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }

    .memo-created {
      font-size: 0.75rem;
      color: hsl(var(--muted-foreground));
    }

    .memo-content {
      white-space: normal!important;
      padding: 1.5rem;
      line-height: 1.6;
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 0.875rem;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .memo-content hr {
      margin: 1rem 0;
      border: none;
      border-top: 1px solid hsl(var(--border));
    }


    .no-memos {
      text-align: center;
      color: hsl(var(--muted-foreground));
      font-size: 1.125rem;
      margin-top: 3rem;
      padding: 3rem;
    }


    /* Tab styles */
    .tabs {
      display: flex;
      background: white;
      border-radius: 8px 8px 0 0;
      overflow: hidden;
      margin-bottom: 0;
      border-bottom: 1px solid hsl(var(--border));
    }
    
    .tab {
      padding: 15px 30px;
      background: hsl(var(--muted));
      border: none;
      cursor: pointer;
      font-size: 16px;
      color: hsl(var(--muted-foreground));
      transition: all 0.2s ease;
    }
    
    .tab.active {
      background: white;
      color: hsl(var(--primary));
      font-weight: 600;
    }
    
    .tab:hover:not(.active) {
      background: hsl(var(--accent));
      color: hsl(var(--accent-foreground));
    }
    
    .tab-content {
      background: white;
      padding: 20px;
      border-radius: 0 0 8px 8px;
      min-height: 600px;
      border: 1px solid hsl(var(--border));
      border-top: none;
    }
    
    /* Trading system styles */
    .current-system {
      background: hsl(var(--muted) / 0.3);
      padding: 20px;
      border-radius: var(--radius);
      margin-bottom: 20px;
      border: 1px solid hsl(var(--border));
    }
    
    .system-content {
      background: hsl(var(--muted) / 0.3);
      padding: 15px;
      border-radius: var(--radius);
      font-family: 'JetBrains Mono', monospace;
      white-space: pre-wrap;
      max-height: 400px;
      overflow-y: auto;
      border: 1px solid hsl(var(--border));
      font-size: 0.875rem;
      line-height: 1.5;
      text-align: left;
      color: hsl(var(--foreground));
      border-left: 4px solid hsl(var(--primary));
    }
    
    .revision {
      background: hsl(var(--card));
      padding: 15px;
      margin: 10px 0;
      border-radius: var(--radius);
      border: 1px solid hsl(var(--border));
      border-left: 4px solid hsl(var(--primary));
    }
    
    .revision-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    
    .revision-info {
      font-weight: 600;
      color: hsl(var(--foreground));
      font-size: 0.95rem;
    }
    
    .revision-notes {
      font-style: italic;
      color: hsl(var(--muted-foreground));
      margin-bottom: 10px;
      font-size: 0.9rem;
    }
    
    .diff {
      background: hsl(var(--muted) / 0.2);
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      padding: 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      margin-top: 10px;
    }
    
    .unified-diff {
      background: white;
      border: 1px solid hsl(var(--border));
      border-radius: 3px;
      margin-top: 8px;
      max-height: 400px;
      overflow-y: auto;
    }
    
    .diff-line {
      display: flex;
      align-items: flex-start;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      line-height: 1.4;
      min-height: 20px;
      padding: 1px 0;
    }
    
    .diff-prefix {
      width: 20px;
      text-align: center;
      font-weight: bold;
      flex-shrink: 0;
      user-select: none;
      padding: 0 4px;
    }
    
    .diff-content {
      flex: 1;
      padding: 0 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    
    .diff-added {
      background: #d1f2d1;
      color: #0c5f0c;
    }
    
    .diff-added .diff-prefix {
      background: #9be79b;
      color: #0c5f0c;
    }
    
    .diff-removed {
      background: #fecaca;
      color: #991b1b;
    }
    
    .diff-removed .diff-prefix {
      background: #f87171;
      color: #991b1b;
    }
    
    .diff-context {
      background: white;
      color: hsl(var(--foreground));
    }
    
    .diff-context .diff-prefix {
      color: hsl(var(--muted-foreground));
    }
    
    .revert {
      color: #856404;
      background: #fff3cd;
      padding: 8px 12px;
      border-radius: var(--radius);
      font-size: 0.875rem;
      border: 1px solid #ffeaa7;
      display: inline-block;
    }
    
    .loading {
      text-align: center;
      color: hsl(var(--muted-foreground));
      padding: 50px;
      font-style: italic;
    }

    @media (max-width: 768px) {
      .container {
        padding: 1rem 0.5rem;
      }
      
      .memo-grid {
        grid-template-columns: 1fr;
      }
      
      .controls {
        flex-direction: column;
        align-items: stretch;
      }
      
      .search-container {
        min-width: unset;
      }
      
      .header h1 {
        font-size: 2rem;
      }
      
      .memo-header {
        padding: 0.75rem 1rem;
      }
      
      .memo-content {
        padding: 1rem;
      }
      
      .tabs {
        flex-direction: column;
      }
      
      .tab {
        text-align: center;
      }
      
      .current-system {
        padding: 15px;
      }
      
      .system-content {
        font-size: 0.8rem;
        max-height: 300px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1 style="text-align: center; margin-bottom: 2rem; color: hsl(var(--foreground));">Trading Dashboard</h1>
    
    <div class="tabs">
      <button class="tab active" onclick="showTab('memos')">Memos</button>
      <button class="tab" onclick="showTab('trading-system')">Trading System</button>
    </div>
    
    <div id="memos" class="tab-content">
      <div class="memo-grid" id="memoGrid">
        ${
          memos.length > 0
            ? memoCards
            : '<div class="no-memos">No trading memos found. Start trading to see decision history here.</div>'
        }
      </div>
    </div>
    
    <div id="trading-system" class="tab-content" style="display: none;">
      <div class="current-system">
        <h3 style="margin-top: 0; color: hsl(var(--foreground));">Current Trading System</h3>
        <div id="current-system-info" class="loading">Loading current system...</div>
      </div>
      
      <h3 style="color: hsl(var(--foreground));">Revision History</h3>
      <div id="revision-history" class="loading">Loading revision history...</div>
    </div>
  </div>

  <button class="btn btn-primary reload-btn" onclick="location.reload()">Reload</button>

  <script>
    const memoGrid = document.getElementById('memoGrid');
    
    // Memos data is already rendered server-side, no need for client-side data
    
    // Make showTab globally available
    window.showTab = function(tabName) {
      try {
        // Hide all tab contents
        document.querySelectorAll('.tab-content').forEach(content => {
          content.style.display = 'none';
        });
        
        // Remove active class from all tabs
        document.querySelectorAll('.tab').forEach(tab => {
          tab.classList.remove('active');
        });
        
        // Show selected tab content
        const targetTab = document.getElementById(tabName);
        if (targetTab) {
          targetTab.style.display = 'block';
        }
        
        // Add active class to the clicked tab
        document.querySelectorAll('.tab').forEach(tab => {
          if (tab.textContent.toLowerCase().includes(tabName.replace('-', ' '))) {
            tab.classList.add('active');
          }
        });
      } catch (error) {
        console.error('Error in showTab:', error);
      }
    };

    async function loadTradingSystem() {
      try {
        const response = await fetch('/api/trading-system');
        const system = await response.json();
        
        document.getElementById('current-system-info').innerHTML = \`
          <div style="margin-bottom: 10px;"><strong>Revision:</strong> \${system.revision}</div>
          <div style="margin-bottom: 10px;"><strong>Created:</strong> \${new Date(system.created_time).toLocaleString()}</div>
          <div style="margin-bottom: 15px;"><strong>Notes:</strong> \${system.revision_notes || 'N/A'}</div>
          <div class="system-content">\${system.content}</div>
        \`;
      } catch (error) {
        document.getElementById('current-system-info').innerHTML = '<div class="loading">Error loading trading system</div>';
      }
    }

    async function loadRevisionHistory() {
      try {
        const response = await fetch('/api/trading-system/history');
        const data = await response.json();
        
        const historyDiv = document.getElementById('revision-history');
        if (data.history.length === 0) {
          historyDiv.innerHTML = '<div class="loading">No revision history found</div>';
          return;
        }
        
        historyDiv.innerHTML = data.history.map(rev => {
          let diffHtml = '';
          if (rev.diff) {
            if (rev.diff.type === 'revert') {
              diffHtml = \`<div class="revert">Reverted to revision \${rev.diff.reverted_to}</div>\`;
            } else if (rev.diff.type === 'patch') {
              // Parse patch format and render as unified diff
              const lines = rev.diff.patch.split('\\n');
              const diffLines = lines.map(line => {
                const prefix = line.charAt(0);
                const content = line.substring(1);
                let type = 'context';
                let displayPrefix = ' ';
                
                if (prefix === '+') {
                  type = 'added';
                  displayPrefix = '+';
                } else if (prefix === '-') {
                  type = 'removed';
                  displayPrefix = '-';
                }
                
                return \`<div class="diff-line diff-\${type}">
                  <span class="diff-prefix">\${displayPrefix}</span>
                  <span class="diff-content">\${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
                </div>\`;
              }).join('');
              
              diffHtml = \`
                <div class="diff">
                  <div style="margin-bottom: 8px;"><strong>Changes:</strong> +\${rev.diff.additions} additions, -\${rev.diff.deletions} deletions</div>
                  <div class="unified-diff">
                    \${diffLines}
                  </div>
                </div>
              \`;
            }
          }
          
          return \`
            <div class="revision">
              <div class="revision-header">
                <div class="revision-info">Revision \${rev.revision} - \${new Date(rev.created_time).toLocaleString()}</div>
              </div>
              <div class="revision-notes">\${rev.revision_notes}</div>
              \${diffHtml}
            </div>
          \`;
        }).join('');
      } catch (error) {
        document.getElementById('revision-history').innerHTML = '<div class="loading">Error loading revision history</div>';
      }
    }








    // Copy memo function
    window.copyMemo = async function(memoId, button) {
      try {
        // Find the memo card and get the raw content
        const memoCard = document.querySelector(\`[data-memo-id="\${memoId}"]\`);
        const rawContentTextarea = memoCard.querySelector('.memo-raw-content');
        const content = rawContentTextarea.value;

        await navigator.clipboard.writeText(content);
        
        // Visual feedback
        const originalText = button.innerHTML;
        button.innerHTML = '✅ Copied!';
        button.classList.add('copied');
        
        setTimeout(() => {
          button.innerHTML = originalText;
          button.classList.remove('copied');
        }, 2000);
      } catch (error) {
        console.error('Failed to copy memo:', error);
        // Fallback for older browsers
        const memoCard = document.querySelector(\`[data-memo-id="\${memoId}"]\`);
        const rawContentTextarea = memoCard.querySelector('.memo-raw-content');
        const content = rawContentTextarea.value;
        
        const textArea = document.createElement('textarea');
        textArea.value = content;
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        
        // Visual feedback
        const originalText = button.innerHTML;
        button.innerHTML = '✅ Copied!';
        button.classList.add('copied');
        
        setTimeout(() => {
          button.innerHTML = originalText;
          button.classList.remove('copied');
        }, 2000);
      }
    };

    // Load trading system data on page load
    loadTradingSystem();
    loadRevisionHistory();

  </script>
</body>
</html>
  `
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Check authentication for all requests
  if (!requireAuth(req, res)) {
    return
  }
  
  const url = new URL(req.url!, `http://${req.headers.host}`)

  if (url.pathname === '/') {
    const limit = url.searchParams.get('limit')
    const memos = getMemos(limit ? parseInt(limit) : 10)

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(renderHTML(memos))
    return
  }

  if (url.pathname === '/api/memos') {
    const limit = url.searchParams.get('limit')
    const memos = getMemos(limit ? parseInt(limit) : undefined)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(memos))
    return
  }

  if (url.pathname === '/api/trading-system') {
    const system = getLatestTradingSystem()
    if (!system) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to load trading system' }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(system))
    return
  }

  if (url.pathname === '/api/trading-system/history') {
    const history = getTradingSystemHistory(5)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ history }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
})

server.listen(PORT, () => {
  logger.info({ port: PORT }, `Memo server running at http://localhost:${PORT}`)
})
