#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types'

interface CalculatorArgs {
  a: number
  b: number
}

const calculatorTools: Tool[] = [
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' }
      },
      required: ['a', 'b']
    }
  },
  {
    name: 'subtract',
    description: 'Subtract two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' }
      },
      required: ['a', 'b']
    }
  },
  {
    name: 'multiply',
    description: 'Multiply two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' }
      },
      required: ['a', 'b']
    }
  },
  {
    name: 'divide',
    description: 'Divide two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'Dividend' },
        b: { type: 'number', description: 'Divisor' }
      },
      required: ['a', 'b']
    }
  }
]

const server = new Server(
  {
    name: 'calculator-server',
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
    tools: calculatorTools
  }
})

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params
  const { a, b } = args as unknown as CalculatorArgs

  switch (name) {
    case 'add': {
      return {
        content: [
          {
            type: 'text',
            text: `${a} + ${b} = ${a + b}`
          }
        ]
      }
    }
    case 'subtract': {
      return {
        content: [
          {
            type: 'text',
            text: `${a} - ${b} = ${a - b}`
          }
        ]
      }
    }
    case 'multiply': {
      return {
        content: [
          {
            type: 'text',
            text: `${a} × ${b} = ${a * b}`
          }
        ]
      }
    }
    case 'divide': {
      if (b === 0) {
        throw new Error('Division by zero is not allowed')
      }
      return {
        content: [
          {
            type: 'text',
            text: `${a} ÷ ${b} = ${a / b}`
          }
        ]
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

main().catch(error => {
  process.exit(1)
})
