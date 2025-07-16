import { chatStream } from './chat';

async function main() {
  const mcpServers = {
    servers: {
      context7: {
        type: 'http' as const,
        url: 'https://mcp.context7.com/sse'
      }
    }
  };

  const messages = [
    {
      role: 'user' as const,
      content: 'I want to learn about React for building trading dashboards. Can you help me find the documentation?'
    }
  ];

  const systemPrompt = 'You are a helpful trading technology assistant. Use available tools to help users find documentation and resources for building trading applications.';

  for await (const chunk of chatStream({ systemPrompt, messages, mcpServers })) {
    process.stdout.write(chunk);
  }
}

// Handle errors and run main function
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} 