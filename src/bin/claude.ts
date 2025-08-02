import { tradingSystemPrompt } from '@/prompts'
import { logger } from '@/utils/logger'
import { query } from '@anthropic-ai/claude-code'
import dayjs from 'dayjs'
import { config } from 'dotenv'
import { exec } from 'child_process'
import { promisify } from 'util'

config()

const execAsync = promisify(exec)

async function sleep(seconds: number) {
  const totalMs = seconds * 1000
  const startTime = Date.now()

  return new Promise(resolve => {
    console.log('\n')
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime
      const remaining = Math.max(0, totalMs - elapsed) / 1000

      if (remaining <= 0) {
        clearInterval(interval)
        process.stdout.write('\r\x1b[K')
        resolve(undefined)
      } else {
        process.stdout.write(`\r${remaining.toFixed(1)}s`)
      }
    }, 100)
  })
}

async function cleanupMcpServer() {
  try {
    logger.info('Cleaning up MCP server processes...')
    
    // Find processes spawned by Claude that contain MCP server paths
    const { stdout } = await execAsync(`ps aux | grep -E "(binance\.ts|chrome\.ts|memo\.ts|wechat\.ts)" | grep -v grep | awk '{print $2}'`)
    
    if (stdout.trim()) {
      const pids = stdout.trim().split('\n').filter(pid => pid)
      logger.info(`Found ${pids.length} MCP server processes to cleanup: ${pids.join(', ')}`)
      
      // Kill the processes
      for (const pid of pids) {
        try {
          await execAsync(`kill -9 ${pid}`)
          logger.debug(`Killed process ${pid}`)
        } catch (error) {
          logger.debug(`Process ${pid} already terminated`)
        }
      }
      
      logger.info('MCP server cleanup completed')
    } else {
      logger.debug('No MCP server processes found to cleanup')
    }
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup MCP server processes')
  }
}

async function runClaude() {
  const date = dayjs().format('YYYY-MM-DD HH:mm:ss')
  for await (const message of query({
    prompt: `UTC:${date} ultrathink, check memos, analyze market, and make decisions`,
    abortController: new AbortController(),
    options: {
      maxTurns: 999,
      customSystemPrompt: tradingSystemPrompt,
      allowedTools: [
        'mcp__binance__get_top_symbols',
        'mcp__binance__calculate_position_size',
        'mcp__binance__get_server_time',
        'mcp__binance__get_klines',
        'mcp__binance__get_klines_all_intervals',
        'mcp__binance__get_orderbook',
        'mcp__binance__get_order',
        'mcp__binance__get_ticker',
        'mcp__binance__get_ticker_24hr',
        'mcp__binance__get_funding_rate',
        'mcp__binance__get_funding_history',
        'mcp__binance__get_mark_price',
        'mcp__binance__get_exchange_info',
        'mcp__binance__get_account',
        'mcp__binance__get_positions',
        'mcp__binance__get_open_orders',
        'mcp__binance__get_trades',
        'mcp__binance__get_current_leverage',
        'mcp__binance__set_leverage',
        'mcp__binance__open_long',
        'mcp__binance__open_short',
        'mcp__binance__close_position',
        'mcp__binance__close_position_limit',
        'mcp__binance__reverse_position',
        'mcp__binance__increase_position',
        'mcp__binance__reduce_position',
        'mcp__binance__set_stop_loss',
        'mcp__binance__set_take_profit',
        'mcp__binance__clear_stops',
        'mcp__binance__cancel_order',
        'mcp__binance__cancel_all_orders',
        'mcp__binance__get_order_history',
        'mcp__binance__get_position_history',
        'mcp__binance__get_income_history',
        'mcp__memo__add_memo',
        'mcp__memo__list_memos',
        'mcp__wechat__push_notification',
        'mcp__chrome__get_screen_by_symbol',
        'mcp__chrome__get_symbol_screenshot_across_timeframes'
      ],
      disallowedTools: [
        'Task',
        'Bash',
        'Glob',
        'Grep',
        'LS',
        'exit_plan_mode',
        'Read',
        'Edit',
        'MultiEdit',
        'Write',
        'NotebookRead',
        'NotebookEdit',
        'WebFetch',
        'TodoWrite',
        'WebSearch'
      ],
      mcpServers: {
        binance: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'tsx', './src/mcpServers/binance.ts']
        },
        memo: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'tsx', './src/mcpServers/memo.ts']
        },
        wechat: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'tsx', './src/mcpServers/wechat.ts']
        },
        chrome: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'tsx', './src/mcpServers/chrome.ts']
        }
      },
      executable: 'node',
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE
    }
  })) {
    switch (message.type) {
      case 'system': {
        break
      }
      case 'assistant': {
        const { content } = message.message
        for (const part of content) {
          if (part.type === 'text') {
            logger.info(part.text)
          } else if (part.type === 'tool_use') {
            logger.debug({ tool: part.name, input: part.input }, 'Tool use')
          } else if (part.type === 'tool_result') {
            logger.debug(part, 'Tool result part')
            for (const item of part.content) {
              switch (item.type) {
                case 'text':
                  logger.debug({ result: item.text }, 'Tool result text')
                  break
                default:
                  logger.debug({ result: item }, 'Tool result item')
                  break
              }
            }
          } else {
            logger.debug(part, 'Unknown part type')
          }
        }
        break
      }
      case 'user': {
        const { content } = message.message
        for (const part of content) {
          logger.debug(part, 'User message part')
        }
        break
      }
      case 'result': {
        switch (message.subtype) {
          case 'success':
            break
          case 'error_max_turns':
            logger.error(message, 'Max turns error')
            break
          case 'error_during_execution':
            logger.error(message, 'Error during execution')
            break
        }
        break
      }
    }
  }
}

while (true) {
  try {
    await runClaude()
    await cleanupMcpServer() // kill MCP server processes
    await sleep(60 * 3) // sleep 3 minutes
  } catch (error) {
    console.error(error)
    await cleanupMcpServer() // cleanup on error too
    await sleep(10) // sleep 10 seconds
  }
}
