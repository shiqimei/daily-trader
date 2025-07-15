# Daily Trader - AI Streaming Test Suite

A comprehensive Node.js TypeScript application for testing and comparing streaming capabilities between AWS Bedrock (Claude models) and OpenAI APIs.

## 🚀 Features

- **Dual Provider Support**: AWS Bedrock and OpenAI integration
- **Real-time Streaming**: Live text generation with immediate output
- **Performance Comparison**: Side-by-side metrics and timing analysis
- **Type-Safe**: Full TypeScript implementation with strict mode
- **Modular Architecture**: Clean service layer pattern for easy extension
- **Comprehensive Error Handling**: Graceful failure management

## 📋 Prerequisites

- **Node.js** 18+ (LTS recommended)
- **pnpm** (fast, efficient package manager)
- **AWS Account** with Bedrock access
- **OpenAI Account** with API access

## 🛠️ Installation

1. **Clone the repository** (or ensure you're in the project directory)
   ```bash
   cd daily-trader
   ```

2. **Install pnpm globally** (if not already installed)
   ```bash
   npm install -g pnpm
   ```

3. **Install dependencies**
   ```bash
   pnpm install
   ```

## ⚙️ Configuration

1. **Copy the environment template**
   ```bash
   cp .env.example .env
   ```

2. **Configure your API credentials** in `.env`:
   ```env
   # AWS Bedrock Configuration
   AWS_ACCESS_KEY_ID=your_aws_access_key_id_here
   AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key_here
   AWS_REGION=us-east-1

   # AWS Bedrock Model IDs (defaults provided)
   BEDROCK_CLAUDE_SONNET_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
   BEDROCK_CLAUDE_OPUS_MODEL_ID=anthropic.claude-3-opus-20240229

   # OpenAI Configuration
   OPENAI_API_KEY=your_openai_api_key_here
   ```

### Getting API Keys

#### AWS Bedrock
1. Log into [AWS Console](https://console.aws.amazon.com/)
2. Navigate to **Bedrock** service
3. Request access to Claude models (may take time for approval)
4. Create IAM user with Bedrock permissions
5. Generate access key and secret

#### OpenAI
1. Visit [OpenAI Platform](https://platform.openai.com/)
2. Navigate to **API Keys** section
3. Create a new API key
4. Copy the key to your `.env` file

## 🎯 Usage

### Quick Start
```bash
# Run the complete test suite
pnpm dev
```

### Available Scripts
```bash
# Development with TypeScript execution
pnpm dev

# Development with auto-restart on file changes
pnpm dev:watch

# Build for production
pnpm build

# Run built version
pnpm start

# Type checking only
pnpm type-check

# Clean build artifacts
pnpm clean
```

## 🧪 What the Application Does

The test suite runs three main demonstrations:

### 1. AWS Bedrock Streaming Test
- Connects to AWS Bedrock Claude Sonnet model
- Streams a creative writing prompt
- Displays real-time response generation
- Reports completion metrics

### 2. OpenAI Streaming Test
- Connects to OpenAI GPT-3.5 model
- Streams the same creative writing prompt
- Shows live text generation
- Provides performance statistics

### 3. Performance Comparison
- Tests both providers with a technical prompt
- Measures response time, chunk count, and content length
- Displays side-by-side performance metrics
- Helps evaluate which service works better for your use case

## 📊 Sample Output

```
🎯 Daily Trader - AI Streaming Test Suite
==========================================

🚀 Testing AWS Bedrock Streaming...

📝 Prompt: Write a short story about a robot learning to paint.

🤖 Claude Sonnet Response:
---
In the sterile halls of TechnoLab, ARIA-7 rolled between workstations...
[Real-time streaming text appears here]
---

✅ Stream completed. Total tokens: ~127 words

🚀 Testing OpenAI Streaming...
[Similar output for OpenAI]

🔄 Comparing Streaming Performance...

📊 Testing AWS Bedrock (Claude Sonnet):
  ✅ Completed in 2341ms
  📦 Chunks received: 23
  📏 Total characters: 856

📊 Testing OpenAI (GPT-3.5):
  ✅ Completed in 1789ms
  📦 Chunks received: 31
  📏 Total characters: 792

🎉 All tests completed!
```

## 🏗️ Project Structure

```
daily-trader/
├── src/
│   ├── config.ts                 # Environment & configuration
│   ├── services/
│   │   ├── bedrockService.ts     # AWS Bedrock integration
│   │   └── openaiService.ts      # OpenAI integration
│   └── main.ts                   # Test suite & demonstrations
├── memory-bank/                  # Project documentation
├── .env                          # Environment variables (create this)
├── .env.example                  # Environment template
├── package.json                  # Dependencies & scripts
├── tsconfig.json                 # TypeScript configuration
└── README.md                     # This file
```

## 🔧 Troubleshooting

### Common Issues

#### "Missing required environment variable"
- Ensure all required variables are set in `.env`
- Check for typos in variable names
- Verify no extra spaces around `=` signs

#### "Access denied" or "Model not found"
- **AWS**: Verify you have Bedrock access and model permissions
- **AWS**: Ensure your region supports the requested models
- **OpenAI**: Check your API key is valid and has sufficient credits

#### "Command not found: pnpm"
- Install pnpm globally: `npm install -g pnpm`
- Alternative: Use `npx pnpm` instead of `pnpm`

#### TypeScript compilation errors
- Run `pnpm type-check` to see detailed errors
- Ensure Node.js version is 18+
- Try deleting `node_modules` and running `pnpm install` again

### Getting Help

1. **Check the logs**: Error messages usually indicate the specific issue
2. **Verify configuration**: Ensure `.env` file has all required values
3. **Test connectivity**: Ensure you can reach AWS and OpenAI APIs
4. **Check model access**: Some AWS Bedrock models require approval

## 🚀 Next Steps

After getting the basic functionality working, consider:

- **Rate Limiting**: Add request throttling for production use
- **Additional Models**: Test GPT-4, Claude Opus, or other variants
- **Concurrent Testing**: Run parallel comparisons
- **Web Interface**: Create a browser-based demonstration
- **Metrics Export**: Save performance data to files for analysis

## 📝 License

ISC License - See package.json for details.

## 🤝 Contributing

This is a demonstration project. Feel free to extend it with additional AI providers, models, or testing scenarios! 