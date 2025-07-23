#!/usr/bin/env node
import { db } from '@/database'
import { tradingSystemPrompt } from '@/prompts'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { diffLines } from 'diff'

// Create trading system table
db.prepare(
  `
  CREATE TABLE IF NOT EXISTS trading_systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_time TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    revision_notes TEXT
  )
`
).run()

// Create index for faster queries
db.prepare('CREATE INDEX IF NOT EXISTS idx_revision ON trading_systems(revision)').run()

// Check if we need to initialize with the first revision
const countStmt = db.prepare('SELECT COUNT(*) as count FROM trading_systems')
const count = countStmt.get() as { count: number }
if (count.count === 0) {
  // Insert initial revision
  const insertStmt = db.prepare(`
    INSERT INTO trading_systems (created_time, revision, content, revision_notes)
    VALUES (?, ?, ?, ?)
  `)
  insertStmt.run(new Date().toISOString(), 1, tradingSystemPrompt, 'Initial trading system')
}

const tools = [
  {
    name: 'get_trading_system',
    description: 'Get the latest revision of the trading system',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'update_trading_system',
    description: 'Update the trading system (creates a new revision)',
    inputSchema: {
      type: 'object',
      properties: {
        updated_trading_system: {
          type: 'string',
          description: 'The updated trading system content'
        },
        revision_notes: {
          type: 'string',
          description: 'Notes about what changed in this revision'
        }
      },
      required: ['updated_trading_system']
    }
  },
  {
    name: 'revert_trading_system',
    description: 'Revert to a previous version of the trading system',
    inputSchema: {
      type: 'object',
      properties: {
        target_revision: {
          type: 'number',
          description: 'The revision number to revert to (optional, defaults to previous revision)'
        }
      }
    }
  },
  {
    name: 'get_revision_history',
    description: 'Get the revision history with diffs',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of revisions to return',
          default: 10
        }
      }
    }
  }
]

const server = new Server(
  {
    name: 'trading-system',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools
}))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'get_trading_system': {
        const latestStmt = db.prepare(`
          SELECT created_time, revision, content, revision_notes
          FROM trading_systems
          ORDER BY revision DESC
          LIMIT 1
        `)
        const latest = latestStmt.get() as {
          created_time: string
          revision: number
          content: string
          revision_notes: string | null
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  created_time: latest.created_time,
                  revision: latest.revision,
                  content: latest.content,
                  revision_notes: latest.revision_notes || ''
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'update_trading_system': {
        const { updated_trading_system, revision_notes } = args as {
          updated_trading_system: string
          revision_notes?: string
        }

        // Get the latest revision number
        const latestStmt = db.prepare('SELECT MAX(revision) as max_revision FROM trading_systems')
        const latest = latestStmt.get() as { max_revision: number }
        const newRevision = (latest.max_revision || 0) + 1

        // Insert new revision
        const insertStmt = db.prepare(`
          INSERT INTO trading_systems (created_time, revision, content, revision_notes)
          VALUES (?, ?, ?, ?)
        `)
        const result = insertStmt.run(
          new Date().toISOString(),
          newRevision,
          updated_trading_system,
          revision_notes || null
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  revision: newRevision,
                  message: `Trading system updated to revision ${newRevision}`
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'revert_trading_system': {
        const { target_revision } = args as { target_revision?: number }

        // Get current revision
        const currentStmt = db.prepare(
          'SELECT MAX(revision) as current_revision FROM trading_systems'
        )
        const current = currentStmt.get() as { current_revision: number }

        // Determine target revision (default to previous)
        const targetRev = target_revision || current.current_revision - 1

        if (targetRev < 1 || targetRev >= current.current_revision) {
          throw new Error(`Invalid target revision: ${targetRev}`)
        }

        // Get the target revision content
        const targetStmt = db.prepare(`
          SELECT content FROM trading_systems WHERE revision = ?
        `)
        const target = targetStmt.get(targetRev) as { content: string }

        if (!target) {
          throw new Error(`Revision ${targetRev} not found`)
        }

        // Create new revision with reverted content
        const newRevision = current.current_revision + 1
        const insertStmt = db.prepare(`
          INSERT INTO trading_systems (created_time, revision, content, revision_notes)
          VALUES (?, ?, ?, ?)
        `)
        insertStmt.run(
          new Date().toISOString(),
          newRevision,
          target.content,
          `Reverted to revision ${targetRev}`
        )

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  revision: newRevision,
                  reverted_to: targetRev,
                  message: `Reverted to revision ${targetRev}, created new revision ${newRevision}`
                },
                null,
                2
              )
            }
          ]
        }
      }

      case 'get_revision_history': {
        const { limit = 10 } = args as { limit?: number }

        // Get revisions
        const revisionsStmt = db.prepare(`
          SELECT created_time, revision, content, revision_notes
          FROM trading_systems
          ORDER BY revision DESC
          LIMIT ?
        `)
        const revisions = revisionsStmt.all(limit) as Array<{
          created_time: string
          revision: number
          content: string
          revision_notes: string | null
        }>

        // Calculate diffs between consecutive revisions
        const history = []
        for (let i = 0; i < revisions.length; i++) {
          const current = revisions[i]
          const previous = i < revisions.length - 1 ? revisions[i + 1] : null

          let diffInfo = null
          if (previous) {
            // Check if this is a revert
            const isRevert = current.revision_notes?.includes('Reverted to revision')
            if (isRevert) {
              // Extract the target revision from notes
              const match = current.revision_notes?.match(/Reverted to revision (\d+)/)
              if (match) {
                diffInfo = {
                  type: 'revert',
                  reverted_to: parseInt(match[1])
                }
              }
            } else {
              // Generate standard unified diff patch
              const oldLines = previous.content.split('\n')
              const newLines = current.content.split('\n')
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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  history,
                  total_revisions: revisions.length
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

async function runServer() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

runServer().catch(console.error)
