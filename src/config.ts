import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface Config {
  aws: {
    bearerToken: string;
    region: string;
    models: {
      claudeSonnet: string;
      claudeOpus: string;
    };
  };
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: Config = {
  aws: {
    bearerToken: getRequiredEnvVar('AWS_BEARER_TOKEN_BEDROCK'),
    region: process.env.AWS_REGION || 'us-east-1',
    models: {
      claudeSonnet: process.env.BEDROCK_CLAUDE_SONNET_MODEL_ID || 'anthropic.claude-sonnet-4-20250514-v1:0',
      claudeOpus: process.env.BEDROCK_CLAUDE_OPUS_MODEL_ID || 'anthropic.claude-opus-4-20250514-v1:0',
    },
  },
}; 