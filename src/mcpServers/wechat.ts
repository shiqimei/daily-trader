#!/usr/bin/env -S npx tsx
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js'

interface PushNotificationArgs {
  title: string
  content: string
}

interface PushPlusResponse {
  code: number
  msg: string
  data?: any
}

const wechatTools: Tool[] = [
  {
    name: 'push_notification',
    description: 'Send a WeChat notification via PushPlus API',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Notification title'
        },
        content: {
          type: 'string',
          description: 'Notification content'
        }
      },
      required: ['title', 'content']
    }
  }
]

class WeChatNotifier {
  private readonly token = '884610d452cc4180abeb5f6619668899'
  private readonly baseUrl = 'https://www.pushplus.plus/send'

  async pushNotification(title: string, content: string): Promise<PushPlusResponse> {
    const url = new URL(this.baseUrl)
    url.searchParams.set('token', this.token)
    url.searchParams.set('title', title)
    url.searchParams.set('content', content)
    url.searchParams.set('template', 'html')

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const result = (await response.json()) as PushPlusResponse
      return result
    } catch (error) {
      throw new Error(
        `Failed to send notification: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }
}

const wechatNotifier = new WeChatNotifier()

const server = new Server(
  {
    name: 'wechat-server',
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
    tools: wechatTools
  }
})

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'push_notification': {
      const { title, content } = args as unknown as PushNotificationArgs

      try {
        const result = await wechatNotifier.pushNotification(title, content)

        if (result.code === 200) {
          return {
            content: [
              {
                type: 'text',
                text: `Notification sent successfully!\nTitle: ${title}\nContent: ${content}\nStatus: ${result.msg}`
              }
            ]
          }
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to send notification\nError: ${result.msg}\nCode: ${result.code}`
              }
            ]
          }
        }
      } catch (error) {
        throw new Error(
          `Failed to send WeChat notification: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
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
  process.exit(0)
})

process.on('SIGTERM', () => {
  process.exit(0)
})

main().catch(() => {
  process.exit(1)
})
