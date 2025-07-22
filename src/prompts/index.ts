import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tradingSystemFilePath = join(__dirname, 'tradingSystem.md')
const systemPromptFilePath = join(__dirname, 'systemPrompt.md')

export const initialTradingSystemPrompt = readFileSync(tradingSystemFilePath, 'utf8')
export const systemPrompt = readFileSync(systemPromptFilePath, 'utf8')
