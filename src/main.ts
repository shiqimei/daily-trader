import { BedrockService } from './services/bedrockService';
import { OpenAIService } from './services/openaiService';

async function testBedrockStreaming() {
  console.log('\n🚀 Testing AWS Bedrock Streaming...\n');
  
  const bedrockService = new BedrockService();
  const prompt = 'Write a short story about a robot learning to paint. Make it creative and engaging.';

  try {
    console.log('📝 Prompt:', prompt);
    console.log('\n🤖 Claude Sonnet Response:');
    console.log('---');
    
    const stream = await bedrockService.streamSonnet(prompt, {
      maxTokens: 500,
      temperature: 0.8,
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
    }
    
    console.log('\n---');
    console.log(`\n✅ Stream completed. Total tokens: ~${fullResponse.split(' ').length} words`);
    
  } catch (error) {
    console.error('❌ Bedrock streaming failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
  }
}

async function testOpenAIStreaming() {
  console.log('\n🚀 Testing OpenAI Streaming...\n');
  
  const openaiService = new OpenAIService();
  const prompt = 'Write a short story about a robot learning to paint. Make it creative and engaging.';

  try {
    console.log('📝 Prompt:', prompt);
    console.log('\n🤖 GPT-3.5 Response:');
    console.log('---');
    
    const stream = await openaiService.streamGPT35(prompt, {
      maxTokens: 500,
      temperature: 0.8,
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
    }
    
    console.log('\n---');
    console.log(`\n✅ Stream completed. Total tokens: ~${fullResponse.split(' ').length} words`);
    
  } catch (error) {
    console.error('❌ OpenAI streaming failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
  }
}

async function compareStreaming() {
  console.log('\n🔄 Comparing Streaming Performance...\n');
  
  const prompt = 'Explain the concept of machine learning in simple terms.';
  const services = [
    { name: 'AWS Bedrock (Claude Sonnet)', service: new BedrockService() },
    { name: 'OpenAI (GPT-3.5)', service: new OpenAIService() },
  ];

  for (const { name, service } of services) {
    console.log(`\n📊 Testing ${name}:`);
    const startTime = Date.now();
    
    try {
      let chunkCount = 0;
      let totalLength = 0;
      
      const stream = service instanceof BedrockService 
        ? await service.streamSonnet(prompt, { maxTokens: 200 })
        : await service.streamGPT35(prompt, { maxTokens: 200 });

      for await (const chunk of stream) {
        chunkCount++;
        totalLength += chunk.length;
        // Don't print chunks during comparison to keep output clean
      }
      
      const duration = Date.now() - startTime;
      console.log(`  ✅ Completed in ${duration}ms`);
      console.log(`  📦 Chunks received: ${chunkCount}`);
      console.log(`  📏 Total characters: ${totalLength}`);
      
    } catch (error) {
      console.error(`  ❌ Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

async function main() {
  console.log('🎯 Daily Trader - AI Streaming Test Suite');
  console.log('==========================================');

  // Test individual services
  await testBedrockStreaming();
  await testOpenAIStreaming();
  
  // Compare performance
  await compareStreaming();
  
  console.log('\n🎉 All tests completed!');
}

// Handle errors and run main function
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
} 