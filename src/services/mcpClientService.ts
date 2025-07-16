import { Client } from '@modelcontextprotocol/sdk/client/index';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import {
  CallToolResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult
} from '@modelcontextprotocol/sdk/types';
import { MCPServerConfig } from '../config';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: any;
  serverName: string;
}

export interface MCPResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

export class MCPClientService {
  private clients: Map<string, Client> = new Map();
  private isInitialized = false;

  async initialize(servers: MCPServerConfig[]): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    for (const serverConfig of servers) {
      try {
        await this.connectToServer(serverConfig);
      } catch (error) {
        console.error(`Failed to connect to MCP server ${serverConfig.name}:`, error);
      }
    }

    this.isInitialized = true;
  }

  private async connectToServer(serverConfig: MCPServerConfig): Promise<void> {
    let transport;

    if (serverConfig.transport === 'sse') {
      // SSE transport for remote servers
      if (!serverConfig.url) {
        throw new Error(`SSE transport requires a URL for server ${serverConfig.name}`);
      }
      
      transport = new SSEClientTransport(new URL(serverConfig.url));
    } else {
      // Default to stdio transport for local servers
      // Create clean environment object
      const cleanEnv: Record<string, string> = {};
      
      // Copy process env with proper type handling
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          cleanEnv[key] = value;
        }
      }
      
      // Add server-specific env vars
      if (serverConfig.env) {
        Object.assign(cleanEnv, serverConfig.env);
      }

      transport = new StdioClientTransport({
        command: serverConfig.command ??'',
        args: serverConfig.args || [],
        env: cleanEnv,
      });
    }

    const client = new Client({
      name: `daily-trader-client-${serverConfig.name}`,
      version: '1.0.0',
    }, {
      capabilities: {
        tools: {},
        resources: {},
      },
    });

    await client.connect(transport);
    this.clients.set(serverConfig.name, client);
  }

  async listAllTools(): Promise<MCPTool[]> {
    const allTools: MCPTool[] = [];

    for (const [serverName, client] of this.clients) {
      try {
        const result = await client.listTools() as ListToolsResult;

        const serverTools: MCPTool[] = result.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverName,
        }));

        allTools.push(...serverTools);
      } catch (error) {
        console.error(`Failed to list tools from server ${serverName}:`, error);
      }
    }

    return allTools;
  }

  async listAllResources(): Promise<MCPResource[]> {
    const allResources: MCPResource[] = [];

    for (const [serverName, client] of this.clients) {
      try {
        const result = await client.listResources() as ListResourcesResult;

        const serverResources: MCPResource[] = result.resources.map(resource => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
          serverName,
        }));

        allResources.push(...serverResources);
      } catch (error) {
        console.error(`Failed to list resources from server ${serverName}:`, error);
      }
    }

    return allResources;
  }

  async callTool(toolName: string, arguments_: any, serverName?: string): Promise<CallToolResult> {
    // Find the client that has this tool
    let targetClient: Client | undefined;
    let targetServerName: string | undefined;

    if (serverName) {
      targetClient = this.clients.get(serverName);
      targetServerName = serverName;
    } else {
      // Search all clients for the tool
      const tools = await this.listAllTools();
      const tool = tools.find(t => t.name === toolName);
      if (tool) {
        targetClient = this.clients.get(tool.serverName);
        targetServerName = tool.serverName;
      }
    }

    if (!targetClient || !targetServerName) {
      throw new Error(`Tool '${toolName}' not found in any connected MCP server`);
    }

    try {
      const result = await targetClient.callTool({
        name: toolName,
        arguments: arguments_,
      }) as CallToolResult;
      
      return result;
    } catch (error) {
      console.error(`Failed to call tool '${toolName}' on server '${targetServerName}':`, error);
      throw error;
    }
  }

  async readResource(uri: string, serverName?: string): Promise<ReadResourceResult> {
    let targetClient: Client | undefined;
    let targetServerName: string | undefined;

    if (serverName) {
      targetClient = this.clients.get(serverName);
      targetServerName = serverName;
    } else {
      // Search all clients for the resource
      const resources = await this.listAllResources();
      const resource = resources.find(r => r.uri === uri);
      if (resource) {
        targetClient = this.clients.get(resource.serverName);
        targetServerName = resource.serverName;
      }
    }

    if (!targetClient || !targetServerName) {
      throw new Error(`Resource '${uri}' not found in any connected MCP server`);
    }

    try {
      const result = await targetClient.readResource({ uri }) as ReadResourceResult;
      return result;
    } catch (error) {
      console.error(`Failed to read resource '${uri}' from server '${targetServerName}':`, error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    for (const [serverName, client] of this.clients) {
      try {
        await client.close();
      } catch (error) {
        console.error(`Error disconnecting from server ${serverName}:`, error);
      }
    }

    this.clients.clear();
    this.isInitialized = false;
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  isServerConnected(serverName: string): boolean {
    return this.clients.has(serverName);
  }
} 