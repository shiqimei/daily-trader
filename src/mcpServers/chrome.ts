#!/usr/bin/env -S npx tsx
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js'
import puppeteer, { Browser, Page } from 'puppeteer'
import { z } from 'zod'

const GetScreenBySymbolSchema = z.object({
  symbol: z.string().describe('Trading symbol (e.g., ETHUSDC)'),
  interval: z.enum(['5m']).describe('Chart interval')
})

const GetSymbolScreenshotAcrossTimeframesSchema = z.object({
  symbol: z.string().describe('Trading symbol (e.g., ETHUSDC)')
})

const toolsList: Tool[] = [
  {
    name: 'get_screen_by_symbol',
    description: 'Capture a screenshot of Binance futures chart for a specific symbol and interval',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading symbol (e.g., ETHUSDC)'
        },
        interval: {
          type: 'string',
          enum: ['5m'],
          description: 'Chart interval'
        }
      },
      required: ['symbol', 'interval']
    }
  },
  {
    name: 'get_symbol_screenshot_across_timeframes',
    description:
      'Capture screenshots of Binance futures chart for 5m interval',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading symbol (e.g., ETHUSDC)'
        }
      },
      required: ['symbol']
    }
  }
]

// Global browser instance and tab management
let browser: Browser | null = null
let tabs: Page[] = []
let currentTabIndex = 0

// Maximum number of tabs to keep open
const MAX_TABS = 1

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await puppeteer.connect({
      browserURL: 'http://localhost:9222',
      defaultViewport: {
        width: 1920,
        height: 1080
      }
    })
  }
  return browser
}

async function getTab(): Promise<Page> {
  const browserInstance = await getBrowser()

  // Initialize tabs if needed (only need 1 tab now)
  if (tabs.length === 0) {
    const pages = await browserInstance.pages()

    // Use existing page or create new one
    if (pages.length >= 1) {
      tabs = pages.slice(0, 1)
    } else {
      tabs = [await browserInstance.newPage()]
    }

    // Set viewport for the tab
    await tabs[0].setViewport({
      width: 1920,
      height: 1080
    })
  }

  // Always return the first (and only) tab
  return tabs[0]
}

async function captureScreenshotOnPage(
  page: Page,
  symbol: string,
  interval: '5m'
): Promise<{ base64: string; symbol: string; interval: string }> {
  // Navigate to Binance futures page
  const url = `https://www.binance.com/en/futures/${symbol}`

  await page.goto(url, {
    waitUntil: 'networkidle2',
    timeout: 30000
  })

  // Try to click on the interval button
  try {
    await page.evaluate(intervalId => {
      const button = document.getElementById(intervalId)
      if (button) {
        button.click()
      }
    }, interval)
  } catch (e) {
    // Continue even if interval button not found
    console.error(`Could not click interval button: ${e}`)
  }

  // Wait for chart to update after interval change
  await new Promise(resolve => setTimeout(resolve, 10 * 1000))

  // Take full page screenshot as base64
  const base64 = await page.screenshot({
    encoding: 'base64',
    fullPage: false,
    clip: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080
    }
  })

  return { base64, symbol, interval }
}

async function captureScreenshot(
  symbol: string,
  interval: '5m'
): Promise<{ base64: string; symbol: string; interval: string }> {
  const page = await getTab()
  return captureScreenshotOnPage(page, symbol, interval)
}

async function captureScreenshotsAcrossTimeframes(symbol: string): Promise<{
  '5m': { base64: string; symbol: string; interval: string }
}> {
  // Get a single tab
  const page = await getTab()

  // Navigate to Binance futures page once
  const url = `https://www.binance.com/en/futures/${symbol}`
  await page.goto(url, {
    waitUntil: 'networkidle2',
    timeout: 30000
  })

  // Wait for initial page load
  await new Promise(resolve => setTimeout(resolve, 5000))

  // Capture 5m screenshot
  try {
    await page.evaluate(() => {
      const button = document.getElementById('5m')
      if (button) {
        button.click()
      }
    })
  } catch (e) {
    console.error(`Could not click 5m interval button: ${e}`)
  }

  // Wait for chart to update
  await new Promise(resolve => setTimeout(resolve, 10000))

  const screenshot5m = await page.screenshot({
    encoding: 'base64',
    fullPage: false,
    clip: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080
    }
  })

  return {
    '5m': { base64: screenshot5m, symbol, interval: '5m' }
  }
}

const server = new Server(
  {
    name: 'chrome',
    vendor: 'daily-trader',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolsList
}))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'get_screen_by_symbol': {
        const { symbol, interval } = GetScreenBySymbolSchema.parse(args)
        const screenshot = await captureScreenshot(symbol, interval)

        return {
          content: [
            {
              type: 'image',
              data: screenshot.base64,
              mimeType: 'image/png'
            } as any
          ]
        }
      }

      case 'get_symbol_screenshot_across_timeframes': {
        const { symbol } = GetSymbolScreenshotAcrossTimeframesSchema.parse(args)
        const screenshots = await captureScreenshotsAcrossTimeframes(symbol)

        return {
          content: [
            {
              type: 'image',
              data: screenshots['5m'].base64,
              mimeType: 'image/png'
            } as any
          ]
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    }
  }
})

async function cleanup() {
  console.error('Cleaning up Chrome MCP Server...')

  // Close all tabs
  if (tabs.length > 0) {
    for (const tab of tabs) {
      try {
        await tab.close()
      } catch (e) {
        // Tab might already be closed
      }
    }
    tabs = []
  }

  // Disconnect from browser
  if (browser) {
    try {
      browser.disconnect()
    } catch (e) {
      // Browser might already be disconnected
    }
    browser = null
  }

  console.error('Chrome MCP Server cleanup complete')
}

async function runServer() {
  const transport = new StdioServerTransport()

  // Set up cleanup handlers
  process.on('SIGINT', async () => {
    await cleanup()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await cleanup()
    process.exit(0)
  })

  process.on('exit', () => {
    // Synchronous cleanup if needed
    if (browser) {
      browser.disconnect()
    }
  })

  await server.connect(transport)
  console.error('Chrome MCP Server running on stdio')
}

runServer().catch(error => {
  console.error('Fatal error running server:', error)
  cleanup().finally(() => {
    process.exit(1)
  })
})
