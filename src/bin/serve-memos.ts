#!/usr/bin/env node

/**
 * A simple self-contained TypeScript server that serves memo data
 * It renders all memos as a modern responsive web ui.
 */

import { db } from '@/database'
import { logger } from '@/utils/logger'
import { createServer, IncomingMessage, ServerResponse } from 'http'

interface Memo {
  id: number
  date: string
  content: string
  created_at: string
}

const PORT = 3001

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
      /(^|<br>)(Account|Positions|Open Orders|Action|Setup|Risk|Active|Watch|ToolCalls|Decisions):/g,
      '$1<strong>$2:</strong>'
    )
}

function formatDateTime(dateStr: string): string {
  try {
    // The dateStr is in format "YYYY-MM-DD HH:MM:SS" and represents UTC time
    // Convert to UTC+8 timezone
    const utcDate = new Date(dateStr + 'Z')
    const utc8Date = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000)
    return utc8Date.toLocaleString('en-US', { timeZone: 'UTC' })
  } catch {
    return dateStr
  }
}

function renderHTML(memos: Memo[]): string {
  const memoCards = memos
    .map(
      memo => `
    <div class="memo-card">
      <div class="memo-header">
        <div class="memo-id">Memo #${memo.id}</div>
        <div class="memo-date">${formatDateTime(memo.date)}</div>
      </div>
      <div class="memo-content">
        ${formatMemoContent(memo.content)}
      </div>
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
  <title>Trading Memos</title>
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
    }
  </style>
</head>
<body>
  <div class="container">

    <div class="memo-grid" id="memoGrid">
      ${
        memos.length > 0
          ? memoCards
          : '<div class="no-memos">No trading memos found. Start trading to see decision history here.</div>'
      }
    </div>
  </div>

  <button class="btn btn-primary reload-btn" onclick="location.reload()">Reload</button>

  <script>
    const searchInput = document.getElementById('searchInput');
    const sortSelect = document.getElementById('sortSelect');
    const memoGrid = document.getElementById('memoGrid');
    let allMemos = ${JSON.stringify(memos)};
    let filteredMemos = [...allMemos];

    function renderMemos(memos) {
      if (memos.length === 0) {
        memoGrid.innerHTML = '<div class="no-memos">No trading memos found matching your search.</div>';
        return;
      }

      const html = memos.map(memo => \`
        <div class="memo-card">
          <div class="memo-header">
            <div class="memo-id">Memo #\${memo.id}</div>
            <div class="memo-date">\${formatDateTime(memo.date)}</div>
          </div>
          <div class="memo-content">
            \${formatMemoContent(memo.content)}
          </div>
        </div>
      \`).join('');
      
      memoGrid.innerHTML = html;
    }

    function formatDateTime(dateStr) {
      try {
        // The dateStr is in format "YYYY-MM-DD HH:MM:SS" and represents UTC time
        // Convert to UTC+8 timezone
        const utcDate = new Date(dateStr + 'Z');
        const utc8Date = new Date(utcDate.getTime() + (8 * 60 * 60 * 1000));
        return utc8Date.toLocaleString('en-US', { timeZone: 'UTC' });
      } catch {
        return dateStr;
      }
    }

    function formatMemoContent(content) {
      // Trim whitespace and convert memo content to HTML with line breaks and bold labels
      return content
        .trim()
        .split('\n')
        .map(line => line.trimStart()) // Remove leading whitespace from each line
        .join('\n')
        .replace(/\n/g, '<br>')
        .replace(/===/g, '<hr>')
        .replace(/(^|<br>)(Account|Positions|Open Orders|Action|Setup|Risk|Active|Watch|ToolCalls|Decisions):/g, '$1<strong>$2:</strong>');
    }

    function filterAndSort() {
      const searchTerm = searchInput.value.toLowerCase();
      const sortBy = sortSelect.value;

      // Filter memos
      filteredMemos = allMemos.filter(memo => 
        memo.content.toLowerCase().includes(searchTerm) ||
        memo.date.toLowerCase().includes(searchTerm) ||
        memo.id.toString().includes(searchTerm)
      );

      // Sort memos
      filteredMemos.sort((a, b) => {
        switch (sortBy) {
          case 'date-asc':
            return new Date(a.date) - new Date(b.date);
          case 'date-desc':
            return new Date(b.date) - new Date(a.date);
          case 'id-asc':
            return a.id - b.id;
          case 'id-desc':
            return b.id - a.id;
          default:
            return new Date(b.date) - new Date(a.date);
        }
      });

      renderMemos(filteredMemos);
    }

    function toggleExpand() {
      const cards = document.querySelectorAll('.memo-card');
      cards.forEach(card => {
        const content = card.querySelector('.memo-content');
        if (content.style.maxHeight === '200px') {
          content.style.maxHeight = 'none';
          content.style.overflow = 'visible';
        } else {
          content.style.maxHeight = '200px';
          content.style.overflow = 'hidden';
        }
      });
    }


    function exportMemos() {
      const data = filteredMemos.map(memo => ({
        id: memo.id,
        date: memo.date,
        content: memo.content,
        created_at: memo.created_at
      }));
      
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`trading-memos-\${new Date().toISOString().split('T')[0]}.json\`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // Event listeners
    searchInput.addEventListener('input', filterAndSort);
    sortSelect.addEventListener('change', filterAndSort);

    // Auto-refresh every 30 seconds
    setInterval(() => {
      location.reload();
    }, 30000);
  </script>
</body>
</html>
  `
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url!, `http://${req.headers.host}`)

  if (url.pathname === '/') {
    const limit = url.searchParams.get('limit')
    const memos = getMemos(limit ? parseInt(limit) : undefined)

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

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
})

server.listen(PORT, () => {
  logger.info({ port: PORT }, `Memo server running at http://localhost:${PORT}`)
})
