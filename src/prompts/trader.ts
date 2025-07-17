import fs from 'fs'
import path from 'path'

const filePath = path.join(__dirname, 'trader.md')
export const traderPrompt = fs.readFileSync(filePath, 'utf8')