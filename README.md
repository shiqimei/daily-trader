# Daily Trader - AWS Bedrock Streaming Test Suite

A comprehensive Node.js TypeScript application for testing and comparing streaming capabilities between Claude models on AWS Bedrock using bearer token authentication.

## 🚀 Features

- **AWS Bedrock Integration**: Secure bearer token authentication
- **Claude Model Support**: Test Claude Sonnet and Opus models
- **Real-time Streaming**: Live text generation with immediate output
- **Model Comparison**: Side-by-side performance metrics between Claude models
- **Type-Safe**: Full TypeScript implementation with strict mode
- **Streamlined Architecture**: Clean single-provider focus
- **Comprehensive Error Handling**: Graceful failure management with token security

## 📋 Prerequisites

- **Node.js** 18+ (LTS recommended)
- **pnpm** (fast, efficient package manager)
- **AWS Account** with Bedrock access
- **AWS Bearer Token** with Bedrock invoke permissions

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

2. **Configure your AWS bearer token** in `.env`:
   ```env
   # AWS Bedrock Configuration
   AWS_BEARER_TOKEN_BEDROCK=your_aws_bearer_token_here

   # AWS Bedrock Model IDs (defaults provided)
   BEDROCK_CLAUDE_SONNET_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
   BEDROCK_CLAUDE_OPUS_MODEL_ID=anthropic.claude-3-opus-20240229
   ```

### Getting AWS Bearer Token

#### AWS CLI Method
1. Install and configure [AWS CLI](https://aws.amazon.com/cli/)
2. Run: `aws sts get-session-token`
3. Use the SessionToken value as your bearer token

#### AWS Console Method
1. Log into [AWS Console](https://console.aws.amazon.com/)
2. Navigate to **Bedrock** service
3. Request access to Claude models (may take time for approval)
4. Generate a bearer token through IAM or use temporary credentials

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

### 1. Claude Sonnet Streaming Test
- Connects to AWS Bedrock Claude Sonnet model
- Streams a creative writing prompt
- Displays real-time response generation with detailed metrics
- Reports completion statistics

### 2. Claude Opus Streaming Test
- Connects to AWS Bedrock Claude Opus model
- Streams a technical explanation prompt
- Shows live text generation with performance tracking
- Provides comprehensive statistics

### 3. Model Performance Comparison
- Tests both Claude models with identical prompts
- Measures response time, chunk count, and content length
- Displays side-by-side performance metrics
- Helps evaluate which model works better for specific use cases

## 📊 Sample Output

```
🎯 Daily Trader - AWS Bedrock Streaming Test Suite
==================================================

🚀 Testing AWS Bedrock Claude Sonnet Streaming...

📝 Prompt: Write a short story about a robot learning to paint.

🤖 Claude Sonnet Response:
---
In the sterile halls of TechnoLab, ARIA-7 rolled between workstations...
[Real-time streaming text appears here]
---

✅ Stream completed in 2341ms
📦 Chunks received: 23
📏 Total characters: 856
📝 Word count: ~127 words

🚀 Testing AWS Bedrock Claude Opus Streaming...
[Similar output for Opus]

🔄 Comparing Claude Models Performance...

📊 Testing Claude Sonnet:
  ✅ Completed in 2341ms
  📦 Chunks received: 23
  📏 Total characters: 856
  📝 Estimated words: ~171 words

📊 Testing Claude Opus:
  ✅ Completed in 2789ms
  📦 Chunks received: 31
  📏 Total characters: 1024
  📝 Estimated words: ~204 words

🎉 All Bedrock tests completed!

💡 Note: Configure your AWS_BEARER_TOKEN_BEDROCK in .env to run these tests
```

## 🏗️ Project Structure

```
daily-trader/
├── src/
│   ├── config.ts                 # Bearer token & configuration
│   ├── services/
│   │   └── bedrockService.ts     # AWS Bedrock integration
│   └── main.ts                   # Claude model test suite
├── memory-bank/                  # Project documentation
├── .env                          # Bearer token configuration (create this)
├── .env.example                  # Environment template
├── package.json                  # Dependencies & scripts
├── tsconfig.json                 # TypeScript configuration
└── README.md                     # This file
```

## 🔧 Troubleshooting

### Common Issues

#### "Missing required environment variable: AWS_BEARER_TOKEN_BEDROCK"
- Ensure the bearer token is set in `.env`
- Check for typos in the variable name
- Verify no extra spaces around `=` signs

#### "Access denied" or "Model not found"
- **Token Permissions**: Verify bearer token has Bedrock invoke permissions
- **Model Access**: Ensure you have access to Claude models in your region
- **Token Expiry**: Check if bearer token has expired and needs refresh

#### "Invalid bearer token" or authentication errors
- Verify bearer token format is correct
- Ensure token has necessary AWS Bedrock permissions
- Try generating a new bearer token

#### TypeScript compilation errors
- Run `pnpm type-check` to see detailed errors
- Ensure Node.js version is 18+
- Try deleting `node_modules` and running `pnpm install` again

### Getting Help

1. **Check the logs**: Error messages usually indicate the specific issue
2. **Verify bearer token**: Ensure `.env` file has valid bearer token
3. **Test connectivity**: Ensure you can reach AWS Bedrock APIs
4. **Check model access**: Some Claude models require approval

## 🚀 Next Steps

After getting the basic functionality working, consider:

- **Token Refresh**: Implement automatic bearer token refresh
- **Additional Models**: Test new Claude model variants as they become available
- **Parallel Testing**: Run concurrent comparisons between models
- **Web Interface**: Create a browser-based demonstration
- **Metrics Export**: Save performance data to files for analysis

## 🔒 Security Notes

- **Bearer Token Security**: Never commit bearer tokens to version control
- **Environment Variables**: Keep `.env` file local and secure
- **Token Rotation**: Regularly rotate bearer tokens for security
- **Permissions**: Use least-privilege principle for bearer token permissions

## 📝 License

ISC License - See package.json for details.

## 🤝 Contributing

This is a demonstration project focused on AWS Bedrock Claude model streaming. Feel free to extend it with additional Claude models or enhanced testing scenarios! 