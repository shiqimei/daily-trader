#!/usr/bin/env node
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
  interval: z.enum(['5m', '30m']).describe('Chart interval')
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
          enum: ['5m', '30m'],
          description: 'Chart interval'
        }
      },
      required: ['symbol', 'interval']
    }
  },
  {
    name: 'get_symbol_screenshot_across_timeframes',
    description:
      'Capture screenshots of Binance futures chart for both 30m and 5m intervals in parallel',
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

  // Initialize tabs if needed
  if (tabs.length === 0) {
    const pages = await browserInstance.pages()

    // Use existing pages or create new ones
    if (pages.length >= 2) {
      tabs = pages.slice(0, 2)
    } else {
      tabs = [...pages]
      while (tabs.length < 2) {
        tabs.push(await browserInstance.newPage())
      }
    }

    // Set viewport for all tabs
    for (const tab of tabs) {
      await tab.setViewport({
        width: 1920,
        height: 1080
      })
    }
  }

  // Get current tab and increment index circularly
  const tab = tabs[currentTabIndex]
  currentTabIndex = (currentTabIndex + 1) % 2

  return tab
}

async function captureScreenshotOnPage(
  page: Page,
  symbol: string,
  interval: '5m' | '30m'
): Promise<{ base64: string; symbol: string; interval: string }> {
  // Navigate to Binance futures page
  const url = `https://www.binance.com/en/futures/${symbol}`

  await page.goto(url, {
    waitUntil: 'networkidle2',
    timeout: 30000
  })

  // Wait for chart canvas to be present and loaded
  try {
    // Wait for the chart container to be visible
    await page.waitForSelector('canvas', {
      visible: true,
      timeout: 20000
    })

    // Additional wait for chart to render completely
    await page.evaluate(() => {
      return new Promise<void>(resolve => {
        // Check if TradingView chart is loaded
        const checkChart = () => {
          const canvas = document.querySelector('canvas')
          const chartContainer = document.querySelector(
            '[class*="chart-container"], [class*="chartContainer"]'
          )

          if (canvas && chartContainer) {
            // Wait a bit more for chart data to render
            setTimeout(resolve, 3000)
          } else {
            setTimeout(checkChart, 500)
          }
        }
        checkChart()
      })
    })
  } catch (e) {
    console.error(`Chart wait timeout: ${e}`)
    // Fallback to fixed wait if chart detection fails
    await new Promise(resolve => setTimeout(resolve, 15000))
  }

  // Try to click on the interval button
  try {
    await page.evaluate(intervalId => {
      const button = document.getElementById(intervalId)
      if (button) {
        button.click()
      }
    }, interval)

    // Wait for chart to update after interval change
    await new Promise(resolve => setTimeout(resolve, 2000))
  } catch (e) {
    // Continue even if interval button not found
    console.error(`Could not click interval button: ${e}`)
  }

  // Take full page screenshot as base64
  const base64 = await page.screenshot({
    encoding: 'base64',
    fullPage: true
  })

  return { base64, symbol, interval }
}

async function captureScreenshot(
  symbol: string,
  interval: '5m' | '30m'
): Promise<{ base64: string; symbol: string; interval: string }> {
  const page = await getTab()
  return captureScreenshotOnPage(page, symbol, interval)
}

async function captureScreenshotsAcrossTimeframes(symbol: string): Promise<{
  '5m': { base64: string; symbol: string; interval: string }
  '30m': { base64: string; symbol: string; interval: string }
}> {
  // Get browser and ensure we have 2 tabs
  const browserInstance = await getBrowser()

  // Initialize tabs if needed
  if (tabs.length === 0) {
    const pages = await browserInstance.pages()

    // Use existing pages or create new ones
    if (pages.length >= 2) {
      tabs = pages.slice(0, 2)
    } else {
      tabs = [...pages]
      while (tabs.length < 2) {
        tabs.push(await browserInstance.newPage())
      }
    }

    // Set viewport for all tabs
    for (const tab of tabs) {
      await tab.setViewport({
        width: 1920,
        height: 1080
      })
    }
  }

  // Use both tabs directly
  const [page1, page2] = tabs

  // Capture screenshots in parallel
  const [screenshot5m, screenshot30m] = await Promise.all([
    captureScreenshotOnPage(page1, symbol, '5m'),
    captureScreenshotOnPage(page2, symbol, '30m')
  ])

  return {
    '5m': screenshot5m,
    '30m': screenshot30m
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
              data: screenshots['30m'].base64,
              mimeType: 'image/png'
            } as any,
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

async function runServer() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Chrome MCP Server running on stdio')
}

runServer().catch(error => {
  console.error('Fatal error running server:', error)
  process.exit(1)
})
