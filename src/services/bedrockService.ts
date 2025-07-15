import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config';

export interface BedrockStreamingOptions {
  modelId: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export class BedrockService {
  private client: BedrockRuntimeClient;

  constructor() {
    this.client = new BedrockRuntimeClient({
      region: config.aws.region,
      credentials: {
        accessKeyId: 'dummy', // Bearer token auth doesn't use these
        secretAccessKey: 'dummy',
        sessionToken: config.aws.bearerToken,
      },
    });
  }

  async streamCompletion(options: BedrockStreamingOptions): Promise<AsyncIterable<string>> {
    const { modelId, prompt, maxTokens = 1000, temperature = 0.7 } = options;

    // Prepare request body based on model type
    const requestBody = this.prepareRequestBody(modelId, prompt, maxTokens, temperature);

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

  private prepareRequestBody(modelId: string, prompt: string, maxTokens: number, temperature: number) {
    if (modelId.includes('anthropic.claude')) {
      return {
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
    }
    
    // Add support for other models as needed
    throw new Error(`Unsupported model: ${modelId}`);
  }

  private async* parseStreamingResponse(stream: any): AsyncIterable<string> {
    const decoder = new TextDecoder();
    
    for await (const chunk of stream) {
      if (chunk.chunk?.bytes) {
        const chunkData = decoder.decode(chunk.chunk.bytes);
        
        try {
          const parsed = JSON.parse(chunkData);
          
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield parsed.delta.text;
          } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
            // Stream ended
            break;
          }
        } catch (error) {
          console.warn('Failed to parse chunk:', chunkData, error);
        }
      }
    }
  }

  // Convenience methods for specific models
  async streamSonnet(prompt: string, options?: Partial<BedrockStreamingOptions>): Promise<AsyncIterable<string>> {
    return this.streamCompletion({
      modelId: config.aws.models.claudeSonnet,
      prompt,
      ...options,
    });
  }

  async streamOpus(prompt: string, options?: Partial<BedrockStreamingOptions>): Promise<AsyncIterable<string>> {
    return this.streamCompletion({
      modelId: config.aws.models.claudeOpus,
      prompt,
      ...options,
    });
  }
} 