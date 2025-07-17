import { config, MCPServerConfig } from '@/config'
import { BedrockService } from './bedrockService'
import { MCPClientService, MCPResource, MCPTool } from './mcpClientService'

export interface AgentPromptOptions {
  includeAvailableTools?: boolean
  includeAvailableResources?: boolean
  contextResourceUris?: string[]
  maxTokens?: number
  temperature?: number
}

export interface ToolCallInstruction {
  toolName: string
  arguments: any
  reasoning?: string
}

export class AgentService {
  private bedrockService: BedrockService
  private mcpService: MCPClientService
  private isInitialized = false
  private customMcpServers?: MCPServerConfig[]

  constructor(customMcpServers?: MCPServerConfig[]) {
    this.bedrockService = new BedrockService()
    this.mcpService = new MCPClientService()
    this.customMcpServers = customMcpServers
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    const serversToUse = this.customMcpServers || config.mcp.servers
    const mcpEnabled = this.customMcpServers ? this.customMcpServers.length > 0 : config.mcp.enabled

    if (mcpEnabled && serversToUse.length > 0) {
      await this.mcpService.initialize(serversToUse)
    } else {
      console.warn('Warning: MCP is disabled or no servers configured')
    }

    this.isInitialized = true
  }

  async streamCompletion(
    prompt: string,
    options: AgentPromptOptions = {}
  ): Promise<AsyncIterable<string>> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    // Build enhanced context
    const enhancedPrompt = await this.buildEnhancedPrompt(prompt, options)

    // Stream response using Bedrock and convert to text only
    const rawStream = await this.bedrockService.streamSonnet(enhancedPrompt, {
      maxTokens: options.maxTokens,
      temperature: options.temperature
    })
    return this.convertStreamToText(rawStream)
  }

  private async *convertStreamToText(stream: AsyncIterable<any>): AsyncIterable<string> {
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        yield chunk.content
      }
    }
  }

  async streamCompletionWithTools(
    prompt: string,
    options: AgentPromptOptions = {}
  ): Promise<AsyncIterable<string>> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    // Get available MCP tools and convert to Bedrock format with MCP naming convention
    const mcpTools = await this.getAvailableTools()
    const bedrockTools = mcpTools.map(tool => ({
      name: `mcp__${tool.serverName}__${tool.name}`,
      description: tool.description || `Tool from ${tool.serverName}`,
      input_schema: {
        type: 'object',
        properties: tool.inputSchema?.properties || {},
        required: tool.inputSchema?.required || []
      }
    }))

    // Build context if requested
    let contextPrompt = prompt
    if (options.includeAvailableResources || options.contextResourceUris) {
      contextPrompt = await this.buildEnhancedPrompt(prompt, {
        ...options,
        includeAvailableTools: false // Tools are provided via API
      })
    }

    return this.processToolUseConversation(contextPrompt, bedrockTools, options)
  }

  private async *processToolUseConversation(
    prompt: string,
    tools: any[],
    options: AgentPromptOptions
  ): AsyncIterable<string> {
    let conversationHistory = [
      {
        role: 'user',
        content: prompt
      }
    ]

    while (true) {
      // Stream response from Claude
      const stream = await this.bedrockService.streamSonnet(prompt, {
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        tools: tools.length > 0 ? tools : undefined
      })

      let currentToolUse: any = null
      let accumulatedJson = ''
      let initialToolInput = null
      let hasTextContent = false

      for await (const chunk of stream) {
        if (chunk.type === 'text') {
          hasTextContent = true
          yield chunk.content
        } else if (chunk.type === 'tool_use_start') {
          currentToolUse = chunk.tool_use
          accumulatedJson = ''
          if (Object.keys(chunk.tool_use.input).length > 0) {
            initialToolInput = chunk.tool_use.input
          }
        } else if (chunk.type === 'tool_use_delta') {
          accumulatedJson += chunk.partial_json
        } else if (chunk.type === 'stop') {
          if (chunk.stop_reason === 'tool_use' && currentToolUse) {
            // Execute the tool
            try {
              const toolInput = initialToolInput || JSON.parse(accumulatedJson || '{}')
              yield `\n[Calling tool] ${currentToolUse.name} ${JSON.stringify(toolInput)}\n`
              const toolResult = await this.executeTool(currentToolUse.name, toolInput)
              yield `\n[Tool executed] ${JSON.stringify(toolResult)}\n`

              conversationHistory.push({
                role: 'assistant',
                content: `Used tool ${currentToolUse.name}`
              })

              conversationHistory.push({
                role: 'user',
                content: `Tool result: ${JSON.stringify(toolResult)}`
              })

              // Create a new prompt for the next iteration
              prompt = this.buildConversationPrompt(conversationHistory)
              break // Continue the conversation loop
            } catch (error) {
              yield `\n[Tool execution failed: ${error}]\n`
              return // End the conversation
            }
          } else {
            // No tool use, conversation is complete
            return
          }
        }
      }

      // If we had text content and no tool use, the conversation is complete
      if (hasTextContent && !currentToolUse) {
        return
      }
    }
  }

  private buildConversationPrompt(history: any[]): string {
    // Build a proper conversation context with all messages
    const conversationText = history
      .map(msg => {
        const role = msg.role === 'user' ? 'Human' : 'Assistant'
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content?.[0]?.content || JSON.stringify(msg.content)
        return `${role}: ${content}`
      })
      .join('\n\n')

    return `${conversationText}\n\nPlease continue the conversation based on the above context.`
  }

  private async buildEnhancedPrompt(
    originalPrompt: string,
    options: AgentPromptOptions
  ): Promise<string> {
    const contextParts: string[] = []

    // Add available tools context
    if (options.includeAvailableTools) {
      const tools = await this.getAvailableTools()
      if (tools.length > 0) {
        contextParts.push(this.formatToolsContext(tools))
      }
    }

    // Add available resources context
    if (options.includeAvailableResources) {
      const resources = await this.getAvailableResources()
      if (resources.length > 0) {
        contextParts.push(this.formatResourcesContext(resources))
      }
    }

    // Add specific resource content
    if (options.contextResourceUris && options.contextResourceUris.length > 0) {
      const resourceContent = await this.loadResourcesContent(options.contextResourceUris)
      if (resourceContent) {
        contextParts.push(resourceContent)
      }
    }

    // Combine context with original prompt
    if (contextParts.length === 0) {
      return originalPrompt
    }

    return `
## Context Information

${contextParts.join('\n\n')}

## User Query

${originalPrompt}

## Instructions

Please use the provided context information to answer the user's query. If you need to perform actions using the available tools, explain what you would do and what arguments you would use. If you need additional context from the available resources, mention which resources would be helpful.
`.trim()
  }

  private formatToolsContext(tools: MCPTool[]): string {
    const toolDescriptions = tools
      .map(tool => {
        const desc = tool.description || 'No description available'
        const mcpToolName = `mcp__${tool.serverName}__${tool.name}`
        const schema = tool.inputSchema
          ? `\n  Parameters: ${JSON.stringify(tool.inputSchema, null, 2)}`
          : ''
        return `- **${mcpToolName}** (from ${tool.serverName}): ${desc}${schema}`
      })
      .join('\n')

    return `### Available Tools

The following tools are available for use:

${toolDescriptions}`
  }

  private formatResourcesContext(resources: MCPResource[]): string {
    const resourceDescriptions = resources
      .map(resource => {
        const name = resource.name || resource.uri
        const desc = resource.description || 'No description available'
        const type = resource.mimeType || 'unknown type'
        return `- **${name}** (${type}, from ${resource.serverName}): ${desc}\n  URI: ${resource.uri}`
      })
      .join('\n')

    return `### Available Resources

The following resources are available for context:

${resourceDescriptions}`
  }

  private async loadResourcesContent(uris: string[]): Promise<string> {
    const contentParts: string[] = []

    for (const uri of uris) {
      try {
        const resource = await this.mcpService.readResource(uri)

        if (resource.contents && resource.contents.length > 0) {
          const content = resource.contents
            .map(item => {
              if (item.type === 'text') {
                return item.text
              } else if (item.type === 'blob' && item.mimeType?.startsWith('text/')) {
                // Convert blob to text if it's a text type
                return item.data && typeof item.data === 'string'
                  ? atob(item.data)
                  : '[Invalid blob data]'
              }
              return `[${item.type} content: ${item.mimeType || 'unknown'}]`
            })
            .join('\n')

          contentParts.push(`### Resource: ${uri}\n\n${content}`)
        }
      } catch (error) {
        console.error(`Failed to load resource ${uri}:`, error)
        contentParts.push(`### Resource: ${uri}\n\n[Error loading resource: ${error}]`)
      }
    }

    return contentParts.length > 0
      ? `### Loaded Resource Content\n\n${contentParts.join('\n\n')}`
      : ''
  }

  async getAvailableTools(): Promise<MCPTool[]> {
    try {
      return await this.mcpService.listAllTools()
    } catch (error) {
      console.error('Failed to get available tools:', error)
      return []
    }
  }

  async getAvailableResources(): Promise<MCPResource[]> {
    try {
      return await this.mcpService.listAllResources()
    } catch (error) {
      console.error('Failed to get available resources:', error)
      return []
    }
  }

  async executeTool(toolName: string, arguments_: any, serverName?: string): Promise<any> {
    try {
      // Parse MCP-style tool names (mcp__server__tool)
      let actualToolName = toolName
      let targetServerName = serverName

      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__')
        if (parts.length >= 3) {
          // Extract server name and tool name from mcp__server__tool format
          targetServerName = parts[1]
          actualToolName = parts.slice(2).join('__') // In case tool name contains underscores
        }
      }

      const result = await this.mcpService.callTool(actualToolName, arguments_, targetServerName)
      return result
    } catch (error) {
      console.error(`Tool execution failed: ${toolName}`, error)
      throw error
    }
  }

  async loadResource(uri: string, serverName?: string): Promise<any> {
    try {
      const result = await this.mcpService.readResource(uri, serverName)
      return result
    } catch (error) {
      console.error(`Resource loading failed: ${uri}`, error)
      throw error
    }
  }

  async getConnectionStatus(): Promise<{
    bedrock: boolean
    mcp: {
      enabled: boolean
      connectedServers: string[]
    }
  }> {
    return {
      bedrock: true, // Bedrock is always available if credentials are configured
      mcp: {
        enabled: config.mcp.enabled,
        connectedServers: this.mcpService.getConnectedServers()
      }
    }
  }

  async disconnect(): Promise<void> {
    await this.mcpService.disconnect()
    this.isInitialized = false
  }

  // Convenience method for trading-specific enhanced prompts
  async streamTradingAnalysis(
    query: string,
    includeMarketData: boolean = true
  ): Promise<AsyncIterable<string>> {
    const contextUris: string[] = []

    // Add market data resources if available and requested
    if (includeMarketData) {
      const resources = await this.getAvailableResources()
      const marketResources = resources.filter(
        r =>
          r.name?.toLowerCase().includes('market') ||
          r.uri.toLowerCase().includes('market') ||
          r.description?.toLowerCase().includes('trading')
      )
      contextUris.push(...marketResources.map(r => r.uri))
    }

    return this.streamCompletion(query, {
      includeAvailableTools: true,
      includeAvailableResources: false,
      contextResourceUris: contextUris,
      maxTokens: 1000,
      temperature: 0.7
    })
  }
}
