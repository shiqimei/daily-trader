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

interface AddMemoArgs {
  date: string
  content: string
}

interface ListMemosArgs {
  last_n?: number
}

interface Memo {
  id: number
  date: string
  content: string
  created_at: string
}

const memoTools: Tool[] = [
  {
    name: 'add_memo',
    description: 'Add a trading memo with date and key insights',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date of the memo in YYYY-MM-DD HH:MM:SS format'
        },
        content: {
          type: 'string',
          description: 'Key trading insights to remember'
        }
      },
      required: ['date', 'content']
    }
  },
  {
    name: 'list_memos',
    description: 'List the most recent trading memos',
    inputSchema: {
      type: 'object',
      properties: {
        last_n: {
          type: 'number',
          description: 'Number of recent memos to retrieve (default: 10, max: 30)'
        }
      }
    }
  }
]

class MemoDatabase {
  constructor(private db: Database = db) {
    this.db = db
    this.initDatabase()
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  addMemo(date: string, content: string): Memo {
    const stmt = this.db.prepare('INSERT INTO memos (date, content) VALUES (?, ?)')
    const result = stmt.run(date, content)

    const memo = this.db
      .prepare('SELECT * FROM memos WHERE id = ?')
      .get(result.lastInsertRowid) as Memo

    return memo
  }

  listMemos(lastN: number = 100): Memo[] {
    const stmt = this.db.prepare('SELECT * FROM memos ORDER BY id DESC LIMIT ?')
    return stmt.all(lastN) as Memo[]
  }

  close() {
    this.db.close()
  }
}

const memoDb = new MemoDatabase(db)

const server = new Server(
  {
    name: 'memo-server',
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
    tools: memoTools
  }
})

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'add_memo': {
      const { date, content } = args as unknown as AddMemoArgs

      try {
        const memo = memoDb.addMemo(date, content)
        return {
          content: [
            {
              type: 'text',
              text: `Memo added successfully:\nID: ${memo.id}\nDate: ${memo.date}\nInsights: ${memo.content}`
            }
          ]
        }
      } catch (error) {
        throw new Error(
          `Failed to add memo: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }

    case 'list_memos': {
      const { last_n = 100 } = (args || {}) as ListMemosArgs

      try {
        const memos = memoDb.listMemos(last_n)

        if (memos.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No memos found'
              }
            ]
          }
        }

        const memoText = memos
          .map(memo => `--- ${memo.date} [${memo.id}] ---\n\n${memo.content}\n`)
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `Trading memo(s):\n\n${memoText}`
            }
          ]
        }
      } catch (error) {
        throw new Error(
          `Failed to list memos: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
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
  memoDb.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  memoDb.close()
  process.exit(0)
})

main().catch(() => {
  memoDb.close()
  process.exit(1)
})
