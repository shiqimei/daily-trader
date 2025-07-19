import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const filePath = join(__dirname, 'trader.md')
export const traderPrompt = readFileSync(filePath, 'utf8')