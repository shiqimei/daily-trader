import { BedrockService } from './services/bedrockService';

async function testBedrockSonnet() {
  console.log('\n🚀 Testing AWS Bedrock Claude Sonnet Streaming...\n');
  
  const bedrockService = new BedrockService();
  const prompt = 'Write a short story about a robot learning to paint. Make it creative and engaging.';

  try {
    console.log('📝 Prompt:', prompt);
    console.log('\n🤖 Claude Sonnet Response:');
    console.log('---');
    
    const startTime = Date.now();
    const stream = await bedrockService.streamSonnet(prompt, {
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
    console.log(`\n✅ Stream completed in ${duration}ms`);
    console.log(`📦 Chunks received: ${chunkCount}`);
    console.log(`📏 Total characters: ${fullResponse.length}`);
    console.log(`📝 Word count: ~${fullResponse.split(' ').length} words`);
    
  } catch (error) {
    console.error('❌ Bedrock Sonnet streaming failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
  }
}

async function testBedrockOpus() {
  console.log('\n🚀 Testing AWS Bedrock Claude Opus Streaming...\n');
  
  const bedrockService = new BedrockService();
  const prompt = 'Explain quantum computing in simple terms, focusing on practical applications.';

  try {
    console.log('📝 Prompt:', prompt);
    console.log('\n🤖 Claude Opus Response:');
    console.log('---');
    
    const startTime = Date.now();
    const stream = await bedrockService.streamOpus(prompt, {
      maxTokens: 400,
      temperature: 0.6,
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
    console.log(`\n✅ Stream completed in ${duration}ms`);
    console.log(`📦 Chunks received: ${chunkCount}`);
    console.log(`📏 Total characters: ${fullResponse.length}`);
    console.log(`📝 Word count: ~${fullResponse.split(' ').length} words`);
    
  } catch (error) {
    console.error('❌ Bedrock Opus streaming failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
  }
}

async function compareModels() {
  console.log('\n🔄 Comparing Claude Models Performance...\n');
  
  const prompt = 'Write a brief summary of artificial intelligence and its current applications.';
  const bedrockService = new BedrockService();
  
  const models = [
    { name: 'Claude Sonnet', method: () => bedrockService.streamSonnet(prompt, { maxTokens: 200, temperature: 0.7 }) },
    { name: 'Claude Opus', method: () => bedrockService.streamOpus(prompt, { maxTokens: 200, temperature: 0.7 }) },
  ];

  for (const { name, method } of models) {
    console.log(`\n📊 Testing ${name}:`);
    const startTime = Date.now();
    
    try {
      let chunkCount = 0;
      let totalLength = 0;
      
      const stream = await method();

      for await (const chunk of stream) {
        chunkCount++;
        totalLength += chunk.length;
        // Don't print chunks during comparison to keep output clean
      }
      
      const duration = Date.now() - startTime;
      console.log(`  ✅ Completed in ${duration}ms`);
      console.log(`  📦 Chunks received: ${chunkCount}`);
      console.log(`  📏 Total characters: ${totalLength}`);
      console.log(`  📝 Estimated words: ~${Math.round(totalLength / 5)} words`);
      
    } catch (error) {
      console.error(`  ❌ Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

async function main() {
  console.log('🎯 Daily Trader - AWS Bedrock Streaming Test Suite');
  console.log('==================================================');

  // Test individual models
  await testBedrockSonnet();
  await testBedrockOpus();
  
  // Compare model performance
  await compareModels();
  
  console.log('\n🎉 All Bedrock tests completed!');
  console.log('\n💡 Note: Configure your AWS_BEARER_TOKEN_BEDROCK in .env to run these tests');
}

// Handle errors and run main function
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
} 