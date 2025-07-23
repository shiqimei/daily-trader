#!/usr/bin/env node

import { db } from '../database/index.js'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const TRADING_SYSTEM_PATH = join(__dirname, '..', 'prompts', 'tradingSystem.md')

const usage = () => {
  console.log(`
Usage: npx tsx src/bin/trading-system-cli.ts [command]

Commands:
  dump     - Restore the latest revision from database to tradingSystem.md
  commit   - Save current tradingSystem.md to database with a message

Examples:
  npx tsx src/bin/trading-system-cli.ts dump
  npx tsx src/bin/trading-system-cli.ts commit "Updated risk management rules"
`)
  process.exit(1)
}

const dumpCommand = () => {
  try {
    const latestRevision = db.prepare(`
      SELECT content FROM trading_systems 
      ORDER BY revision DESC 
      LIMIT 1
    `).get() as { content: string } | undefined

    if (!latestRevision) {
      console.error('Error: No revisions found in database')
      process.exit(1)
    }

    writeFileSync(TRADING_SYSTEM_PATH, latestRevision.content, 'utf-8')
    console.log('Successfully restored latest revision to tradingSystem.md')
  } catch (error) {
    console.error('Error dumping revision:', error)
    process.exit(1)
  }
}

const commitCommand = (message: string) => {
  if (!message) {
    console.error('Error: Commit message is required')
    console.log('Usage: npx tsx src/bin/trading-system-cli.ts commit "Your commit message"')
    process.exit(1)
  }

  try {
    const content = readFileSync(TRADING_SYSTEM_PATH, 'utf-8')
    
    // Get the next revision number
    const lastRevision = db.prepare(`
      SELECT revision FROM trading_systems 
      ORDER BY revision DESC 
      LIMIT 1
    `).get() as { revision: number } | undefined
    
    const nextRevision = (lastRevision?.revision || 0) + 1
    
    const stmt = db.prepare(`
      INSERT INTO trading_systems (created_time, revision, content, revision_notes)
      VALUES (datetime('now'), ?, ?, ?)
    `)
    
    const result = stmt.run(nextRevision, content, message)
    console.log(`Successfully committed revision #${nextRevision} with message: "${message}"`)
  } catch (error) {
    console.error('Error committing revision:', error)
    process.exit(1)
  }
}

const main = () => {
  const args = process.argv.slice(2)
  
  if (args.length === 0) {
    usage()
  }

  const command = args[0].toLowerCase()

  switch (command) {
    case 'dump':
      dumpCommand()
      break
    case 'commit':
      const message = args.slice(1).join(' ')
      commitCommand(message)
      break
    default:
      console.error(`Unknown command: ${command}`)
      usage()
  }
}

main()