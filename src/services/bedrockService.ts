import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config';

export interface BedrockTool {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface BedrockStreamingOptions {
  modelId: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  tools?: BedrockTool[];
}

export class BedrockService {
  private client: BedrockRuntimeClient;

  constructor() {
    // Use traditional AWS credentials if available, otherwise fall back to bearer token
    const clientConfig: any = {
      region: config.aws.region,
    };

    if (config.aws.accessKeyId && config.aws.secretAccessKey) {
      // Traditional AWS credentials
      clientConfig.credentials = {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
      };
    } else {
      throw new Error('No valid AWS credentials found');
    }

    this.client = new BedrockRuntimeClient(clientConfig);
  }

  async streamCompletion(options: BedrockStreamingOptions): Promise<AsyncIterable<any>> {
    const { modelId, prompt, maxTokens = 1000, temperature = 0.7, tools } = options;

    // Prepare request body based on model type
    const requestBody = this.prepareRequestBody(modelId, prompt, maxTokens, temperature, tools);

    const command = new InvokeModelWithResponseStreamCommand({
      modelId,
      body: JSON.stringify(requestBody),
      contentType: 'application/json',
      accept: 'application/json',
    });

    try {
      const response = await this.client.send(command);
      
      if (!response.body) {
        throw new Error('No response body received from Bedrock');
      }

      return this.parseStreamingResponse(response.body);
    } catch (error) {
      console.error('Error streaming from Bedrock:', error);
      throw error;
    }
  }

  private prepareRequestBody(modelId: string, prompt: string, maxTokens: number, temperature: number, tools?: BedrockTool[]) {
    if (modelId.includes('anthropic.claude')) {
      const requestBody: any = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        temperature,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      };

      // Add tools if provided
      if (tools && tools.length > 0) {
        requestBody.tools = tools;
      }

      return requestBody;
    }
    
    // Add support for other models as needed
    throw new Error(`Unsupported model: ${modelId}`);
  }

  private async* parseStreamingResponse(stream: any): AsyncIterable<any> {
    const decoder = new TextDecoder();
    
    for await (const chunk of stream) {
      if (chunk.chunk?.bytes) {
        const chunkData = decoder.decode(chunk.chunk.bytes);
        
        try {
          const parsed = JSON.parse(chunkData);
          
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield { type: 'text', content: parsed.delta.text };
          } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            yield { 
              type: 'tool_use_start', 
              tool_use: parsed.content_block 
            };
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.partial_json) {
            yield { 
              type: 'tool_use_delta', 
              partial_json: parsed.delta.partial_json 
            };
          } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
            yield { 
              type: 'stop', 
              stop_reason: parsed.delta.stop_reason 
            };
            break;
          }
        } catch (error) {
          console.warn('Failed to parse chunk:', chunkData, error);
        }
      }
    }
  }

  // Convenience method for Claude Sonnet
  async streamSonnet(prompt: string, options?: Partial<BedrockStreamingOptions>): Promise<AsyncIterable<any>> {
    return this.streamCompletion({
      modelId: config.aws.models.claudeSonnet,
      prompt,
      ...options,
    });
  }

  // Convenience method for Claude Sonnet that returns text only (for backwards compatibility)
  async streamSonnetText(prompt: string, options?: Partial<BedrockStreamingOptions>): Promise<AsyncIterable<string>> {
    const stream = await this.streamSonnet(prompt, options);
    return this.convertToTextStream(stream);
  }

  private async* convertToTextStream(stream: AsyncIterable<any>): AsyncIterable<string> {
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        yield chunk.content;
      }
    }
  }
} 