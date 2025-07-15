
import 'dotenv/config';

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse';
  url?: string; // Required for SSE transport
}

export interface Config {
  aws: {
    // Traditional AWS credentials (preferred)
    accessKeyId?: string;
    secretAccessKey?: string;
    // Bearer token (alternative)
    bearerToken?: string;
    region: string;
    models: {
      claudeSonnet: string;
    };
  };
  mcp: {
    servers: MCPServerConfig[];
    enabled: boolean;
  };
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Validate that we have either traditional AWS credentials or bearer token
function validateAwsCredentials() {
  const hasTraditionalCreds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
  const hasBearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  
  if (!hasTraditionalCreds && !hasBearerToken) {
    throw new Error(
      'Missing AWS credentials. Please provide either:\n' +
      '  - AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (recommended), or\n' +
      '  - AWS_BEARER_TOKEN_BEDROCK'
    );
  }
  
  if (hasTraditionalCreds && hasBearerToken) {
    console.warn('Both traditional AWS credentials and bearer token found. Using traditional credentials.');
  }
}

// Validate credentials before creating config
validateAwsCredentials();

// Default MCP servers configuration
function getDefaultMCPServers(): MCPServerConfig[] {
  const servers: MCPServerConfig[] = [];
  
  // Example: File system MCP server
  if (process.env.MCP_FILESYSTEM_SERVER_PATH) {
    servers.push({
      name: 'filesystem',
      command: process.env.MCP_FILESYSTEM_SERVER_PATH,
      args: ['/home/ubuntu/daily-trader'], // Allow access to current directory
      transport: 'stdio',
    });
  }
  
  // Example: Web search MCP server
  if (process.env.MCP_WEBSEARCH_SERVER_PATH) {
    servers.push({
      name: 'websearch',
      command: 'node',
      args: [process.env.MCP_WEBSEARCH_SERVER_PATH],
      transport: 'stdio',
      env: {
        SEARCH_API_KEY: process.env.SEARCH_API_KEY || '',
      },
    });
  }

  // SSE MCP server for testing
  servers.push({
    name: 'context7-sse',
    command: '', // Not used for SSE transport
    transport: 'sse',
    url: 'https://mcp.context7.com/sse',
  });
  
  return servers;
}

export const config: Config = {
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    bearerToken: process.env.AWS_BEARER_TOKEN_BEDROCK,
    region: process.env.AWS_REGION || 'us-east-1',
    models: {
      claudeSonnet: process.env.BEDROCK_CLAUDE_SONNET_MODEL_ID || 'apac.anthropic.claude-sonnet-4-20250514-v1:0',
    },
  },
  mcp: {
    enabled: process.env.MCP_ENABLED !== 'false',
    servers: getDefaultMCPServers(),
  },
}; 