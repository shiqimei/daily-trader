import { AgentService } from './services/agentService';
import { BedrockService } from './services/bedrockService';

async function testBedrockSonnet() {
  console.log('\nTesting AWS Bedrock Claude Sonnet Streaming...\n');
  
  const bedrockService = new BedrockService();
  const prompt = 'Write a short story about a robot learning to paint. Make it creative and engaging.';

  try {
    console.log('Prompt:', prompt);
    console.log('\nClaude Sonnet Response:');
    console.log('---');
    
    const startTime = Date.now();
    const stream = await bedrockService.streamSonnetText(prompt, {
      maxTokens: 500,
      temperature: 0.8,
    });

    let fullResponse = '';
    let chunkCount = 0;
    
    for await (const chunk of stream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
      chunkCount++;
    }
    
    const duration = Date.now() - startTime;
    
    console.log('\n---');
    console.log(`\nStream completed in ${duration}ms`);
    console.log(`Chunks received: ${chunkCount}`);
    console.log(`Total characters: ${fullResponse.length}`);
    console.log(`Word count: ~${fullResponse.split(' ').length} words`);
    
  } catch (error) {
    console.error('Bedrock Sonnet streaming failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
  }
}

async function testAgentService() {
  console.log('\nTesting Agent Service Integration...\n');
  
  const agentService = new AgentService();
  
  try {
    // Initialize the agent service
    await agentService.initialize();
    
    // Check connection status
    const status = await agentService.getConnectionStatus();
    console.log('Connection Status:');
    console.log(`  Bedrock: ${status.bedrock ? 'Connected' : 'Disconnected'}`);
    console.log(`  MCP Enabled: ${status.mcp.enabled ? 'Yes' : 'No'}`);
    console.log(`  MCP Servers: ${status.mcp.connectedServers.length} connected`);
    
    if (status.mcp.connectedServers.length > 0) {
      console.log('  Connected servers:');
      status.mcp.connectedServers.forEach(serverName => {
        console.log(`    - ${serverName}`);
      });
    }
    
    // List available tools and resources
    console.log('\nAvailable MCP Capabilities:');
    
    const tools = await agentService.getAvailableTools();
    console.log(`Tools: ${tools.length} available`);
    tools.forEach(tool => {
      console.log(`  - ${tool.name} (${tool.serverName}): ${tool.description || 'No description'}`);
    });
    console.log(tools)
    
    const resources = await agentService.getAvailableResources();
    console.log(`Resources: ${resources.length} available`);
    resources.slice(0, 10).forEach(resource => { // Show first 10 resources
      console.log(`  - ${resource.name || resource.uri} (${resource.serverName})`);
    });
    if (resources.length > 10) {
      console.log(`  ... and ${resources.length - 10} more`);
    }

    // Test SSE MCP server specifically
    if (status.mcp.connectedServers.includes('context7-sse')) {
      console.log('\n🌐 Testing SSE MCP Server (context7.com)...');
      
      const sseTools = tools.filter(tool => tool.serverName === 'context7-sse');
      const sseResources = resources.filter(resource => resource.serverName === 'context7-sse');
      
      console.log(`SSE Server Tools: ${sseTools.length}`);
      sseTools.forEach(tool => {
        console.log(`  📋 ${tool.name}: ${tool.description || 'No description'}`);
      });
      
      console.log(`SSE Server Resources: ${sseResources.length}`);
      sseResources.slice(0, 5).forEach(resource => {
        console.log(`  📄 ${resource.name || resource.uri}`);
      });
      
      // Test tool-enabled completion with SSE server tools
      if (sseTools.length > 0) {
        console.log('\nTesting Agent Completion with SSE Server Tools...');
        
        const prompt = 'What tools and capabilities are available from the Context7 SSE MCP server? Please explore and describe what you can do.';
        console.log('Prompt:', prompt);
        console.log('\nAgent Response:');
        console.log('---');
        
        const startTime = Date.now();
        const stream = await agentService.streamCompletionWithTools(prompt, {
          includeAvailableTools: true,
          includeAvailableResources: true,
          maxTokens: 1000,
          temperature: 0.7,
        });
        
        let fullResponse = '';
        let chunkCount = 0;
        
        for await (const chunk of stream) {
          process.stdout.write(chunk);
          fullResponse += chunk;
          chunkCount++;
        }
        
        const duration = Date.now() - startTime;
        
        console.log('\n---');
        console.log(`\nSSE server test completed in ${duration}ms`);
        console.log(`Chunks received: ${chunkCount}`);
        console.log(`Total characters: ${fullResponse.length}`);
      }
    } else {
      console.log('\n⚠️  SSE MCP server (context7-sse) not connected');
    }
    
    // Test tool-enabled completion with all available tools
    console.log('\nTesting Agent Completion with All Available Tools...');
    
    const prompt = 'Please help me understand what MCP servers are connected and what tools they provide. Also, if there are any file-related tools, list the files in the current directory.';
    console.log('Prompt:', prompt);
    console.log('\nAgent Response:');
    console.log('---');
    
    const startTime = Date.now();
    const stream = await agentService.streamCompletionWithTools(prompt, {
      includeAvailableResources: true,
      maxTokens: 1000,
      temperature: 0.7,
    });
    
    let fullResponse = '';
    let chunkCount = 0;
    
    for await (const chunk of stream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
      chunkCount++;
    }
    
    const duration = Date.now() - startTime;
    
  } catch (error) {
    console.error('Agent Service test failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
  }
}

async function main() {
  await testAgentService();
}

// Handle errors and run main function
// ES module equivalent of require.main === module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} 