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
      claudeSonnet: process.env.BEDROCK_CLAUDE_SONNET_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      claudeOpus: process.env.BEDROCK_CLAUDE_OPUS_MODEL_ID || 'anthropic.claude-3-opus-20240229',
    },
  },
}; 