# Product Context: AWS Bedrock Streaming Test Suite

## Why This Project Exists

This project serves as a comprehensive testing platform for AWS Bedrock Claude model streaming capabilities using bearer token authentication. It addresses the need to:

1. **Evaluate Claude Models**: Compare performance between Claude Sonnet and Opus
2. **Test Bedrock Integration**: Validate AWS Bedrock streaming API integration patterns
3. **Streaming Capabilities**: Demonstrate real-time response streaming for user interfaces
4. **Bearer Token Auth**: Implement secure bearer token authentication for AWS Bedrock

## Problems It Solves

- **Model Comparison**: No easy way to compare streaming performance between Claude models
- **Integration Complexity**: Complex setup required for AWS Bedrock streaming with bearer tokens
- **Testing Framework**: Need for standardized testing of Claude streaming capabilities
- **Authentication Management**: Proper handling of bearer token authentication

## How It Should Work

### User Experience Flow
1. User configures bearer token in `.env` file
2. User runs the application with simple npm scripts
3. Application demonstrates streaming from both Claude models
4. User sees real-time output and performance metrics
5. User can compare response quality and speed between models

### Core Functionality
- **Individual Model Tests**: Separate tests for Claude Sonnet and Opus
- **Performance Metrics**: Timing, chunk count, character count, word estimates
- **Error Handling**: Graceful failure with informative messages
- **Model Architecture**: Easy to extend with new Claude models

## User Experience Goals

- **Simplicity**: Single command to run all tests
- **Clarity**: Clear output showing streaming in real-time
- **Comparison**: Side-by-side performance metrics between Claude models
- **Bearer Token Security**: Secure token-based authentication
- **Reliability**: Robust error handling and recovery 