import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tradingSystemFilePath = join(__dirname, 'tradingSystem.md')

export const tradingSystemPrompt = readFileSync(tradingSystemFilePath, 'utf8')
