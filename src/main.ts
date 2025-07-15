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
      console.log(`    - ${status.mcp.connectedServers.join('\n    - ')}`);
    }
    
    // List available tools and resources
    console.log('\nAvailable MCP Capabilities:');
    
    const tools = await agentService.getAvailableTools();
    console.log(`Tools: ${tools.length} available`);
    tools.forEach(tool => {
      console.log(`  - ${tool.name} (${tool.serverName}): ${tool.description || 'No description'}`);
    });
    
    const resources = await agentService.getAvailableResources();
    console.log(`Resources: ${resources.length} available`);
    resources.slice(0, 5).forEach(resource => { // Show first 5 resources
      console.log(`  - ${resource.name || resource.uri} (${resource.serverName})`);
    });
    if (resources.length > 5) {
      console.log(`  ... and ${resources.length - 5} more`);
    }
    
    // Test tool-enabled completion
    console.log('\nTesting Agent Completion with Tools...');
    
    const prompt = 'Please help me list the files in the current directory and read the content of test-file.txt if it exists.';
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
    
    console.log('\n---');
    console.log(`\nAgent completion with tools finished in ${duration}ms`);
    console.log(`Chunks received: ${chunkCount}`);
    console.log(`Total characters: ${fullResponse.length}`);
    
    // Test trading-specific analysis if we have market-related resources
          if (resources.some(r => r.name?.toLowerCase().includes('market') || r.uri.toLowerCase().includes('market'))) {
        console.log('\nTesting Trading Analysis...');
        
        const tradingQuery = 'What are the key indicators I should watch for cryptocurrency trading today?';
        console.log('Trading Query:', tradingQuery);
        console.log('\nTrading Analysis Response:');
      console.log('---');
      
              const tradingStream = await agentService.streamTradingAnalysis(tradingQuery);
      
      for await (const chunk of tradingStream) {
        process.stdout.write(chunk);
      }
      
              console.log('\n---');
        console.log('Trading analysis completed');
    }
    
    // Clean up
    await agentService.disconnect();
    
  } catch (error) {
    console.error('Agent Service test failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
  }
}

async function testAdvancedSonnet() {
  console.log('\nTesting Claude Sonnet Advanced Features...\n');
  
  const prompt = 'Write a brief summary of artificial intelligence and its current applications.';
  const bedrockService = new BedrockService();
  
  console.log('Testing Claude Sonnet with different parameters:');
  const startTime = Date.now();
  
  try {
    let chunkCount = 0;
    let totalLength = 0;
    
    const stream = await bedrockService.streamSonnetText(prompt, { maxTokens: 300, temperature: 0.7 });

    for await (const chunk of stream) {
      chunkCount++;
      totalLength += chunk.length;
      // Don't print chunks during comparison to keep output clean
    }
    
    const duration = Date.now() - startTime;
    console.log(`  Completed in ${duration}ms`);
    console.log(`  Chunks received: ${chunkCount}`);
    console.log(`  Total characters: ${totalLength}`);
    console.log(`  Estimated words: ~${Math.round(totalLength / 5)} words`);
    
  } catch (error) {
    console.error(`  Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function main() {
  console.log('Daily Trader - Agent Service Test Suite');
  console.log('===============================================');

  // Test basic Bedrock functionality
  await testBedrockSonnet();
  
  // Test agent service functionality
  await testAgentService();
  
  // Test advanced features
  await testAdvancedSonnet();
  
  console.log('\nAll tests completed!');
  console.log('\nNote: AWS credentials configured via environment variables');
  console.log('MCP servers can be configured via environment variables:');
  console.log('   - MCP_ENABLED=true/false');
  console.log('   - MCP_FILESYSTEM_SERVER_PATH=/path/to/filesystem/server');
  console.log('   - MCP_WEBSEARCH_SERVER_PATH=/path/to/websearch/server');
  console.log('   - SEARCH_API_KEY=your_search_api_key');
}

// Handle errors and run main function
// ES module equivalent of require.main === module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} 