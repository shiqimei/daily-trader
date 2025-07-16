import { MCPServerConfig } from './config';
import { AgentService } from './services/agentService';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    source?: {
      type: 'base64';
      media_type: string;
      data: string;
    };
  }> | string;
}

export interface MCPServers {
  servers: Record<string, {
    type: 'http' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

export interface ChatStreamOptions {
  systemPrompt?: string;
  messages: ChatMessage[];
  mcpServers?: MCPServers;
  maxTokens?: number;
  temperature?: number;
}

export async function* chatStream({
  systemPrompt,
  messages,
  mcpServers = { servers: {} },
  maxTokens = 1000,
  temperature = 0.7
}: ChatStreamOptions): AsyncIterable<string> {

  // Convert MCP servers config to our internal format
  const internalMcpServers: MCPServerConfig[] = Object.entries(mcpServers.servers).map(([name, config]) => {
    if (config.type === 'http') {
      return {
        name,
        command: '', // Not used for HTTP
        transport: 'sse' as const,
        url: config.url,
      };
    } else {
      return {
        name,
        command: config.command || '',
        args: config.args,
        env: config.env,
        transport: 'stdio' as const,
      };
    }
  });

  // Create agent service with custom MCP servers
  const agentService = new AgentService(internalMcpServers.length > 0 ? internalMcpServers : undefined);

  await agentService.initialize();

  try {
    const prompt = buildPromptFromMessages(systemPrompt, messages);
    const tools = await agentService.getAvailableTools();

    if (tools.length > 0) {
      const stream = await agentService.streamCompletionWithTools(prompt, {
        maxTokens,
        temperature,
        includeAvailableTools: true,
      });
      yield* stream;
    } else {
      const stream = await agentService.streamCompletion(prompt, {
        maxTokens,
        temperature,
      });
      yield* stream;
    }

  } finally {
    await agentService.disconnect();
  }
}

function buildPromptFromMessages(systemPrompt: string | undefined, messages: ChatMessage[]): string {
  const parts: string[] = [];

  if (systemPrompt) {
    parts.push(`System: ${systemPrompt}`);
  }

  for (const message of messages) {
    if (typeof message.content === 'string') {
      parts.push(`${message.role}: ${message.content}`);
    } else {
      const contentParts: string[] = [];

      for (const item of message.content) {
        if (item.type === 'text' && item.text) {
          contentParts.push(item.text);
        } else if (item.type === 'image' && item.source) {
          contentParts.push(`[Image: ${item.source.media_type}]`);
        }
      }

      parts.push(`${message.role}: ${contentParts.join(' ')}`);
    }
  }

  return parts.join('\n\n');
}