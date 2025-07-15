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



async function testAdvancedSonnet() {
  console.log('\n🔄 Testing Claude Sonnet Advanced Features...\n');
  
  const prompt = 'Write a brief summary of artificial intelligence and its current applications.';
  const bedrockService = new BedrockService();
  
  console.log('📊 Testing Claude Sonnet with different parameters:');
  const startTime = Date.now();
  
  try {
    let chunkCount = 0;
    let totalLength = 0;
    
    const stream = await bedrockService.streamSonnet(prompt, { maxTokens: 300, temperature: 0.7 });

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

async function main() {
  console.log('🎯 Daily Trader - AWS Bedrock Claude Sonnet Test Suite');
  console.log('=======================================================');

  // Test Claude Sonnet
  await testBedrockSonnet();
  
  // Test advanced features
  await testAdvancedSonnet();
  
  console.log('\n🎉 All Bedrock tests completed!');
  console.log('\n💡 Note: AWS credentials configured via environment variables');
}

// Handle errors and run main function
// ES module equivalent of require.main === module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
} 