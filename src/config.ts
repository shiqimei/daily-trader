
import 'dotenv/config';

export interface MCPServerConfig {
  name: string;
  transport: 'stream-http' | 'stdio' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Config {
  aws: {
    accessKeyId?: string;
    secretAccessKey?: string;
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

function validateAwsCredentials() {
  const hasTraditionalCreds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;

  if (!hasTraditionalCreds) {
    throw new Error(
      'Missing AWS credentials. Please provide either:\n' +
      '  - AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (recommended), or\n' +
      '  - AWS_BEARER_TOKEN_BEDROCK'
    );
  }
}

validateAwsCredentials();

export const config: Config = {
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    bearerToken: process.env.AWS_BEARER_TOKEN_BEDROCK,
    region: process.env.AWS_REGION || 'us-east-1',
    models: {
      claudeSonnet: process.env.BEDROCK_CLAUDE_SONNET_MODEL_ID || 'arn:aws:bedrock:ap-northeast-1:544018208436:inference-profile/apac.anthropic.claude-sonnet-4-20250514-v1:0',
    },
  },
  mcp: {
    enabled: process.env.MCP_ENABLED !== 'false',
    servers: [],
  },
}; 