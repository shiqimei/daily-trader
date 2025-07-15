# Product Context: AI Streaming Test Suite

## Why This Project Exists

This project serves as a comprehensive testing and comparison platform for AI streaming APIs, specifically targeting AWS Bedrock (Claude models) and OpenAI's GPT models. It addresses the need to:

1. **Evaluate Performance**: Compare response times and streaming efficiency between providers
2. **Test Integration**: Validate API integration patterns for both AWS Bedrock and OpenAI
3. **Streaming Capabilities**: Demonstrate real-time response streaming for user interfaces
4. **Development Foundation**: Provide a solid foundation for AI-powered applications

## Problems It Solves

- **API Comparison**: No easy way to compare streaming performance between AWS Bedrock and OpenAI
- **Integration Complexity**: Complex setup required for both AWS and OpenAI streaming APIs
- **Testing Framework**: Need for standardized testing of AI streaming capabilities
- **Configuration Management**: Proper handling of multiple API keys and configurations

## How It Should Work

### User Experience Flow
1. User configures API keys in `.env` file
2. User runs the application with simple npm scripts
3. Application demonstrates streaming from both providers
4. User sees real-time output and performance metrics
5. User can compare response quality and speed

### Core Functionality
- **Streaming Tests**: Individual tests for each AI provider
- **Performance Metrics**: Timing, chunk count, character count
- **Error Handling**: Graceful failure with informative messages
- **Modular Architecture**: Easy to extend with new providers or models

## User Experience Goals

- **Simplicity**: Single command to run all tests
- **Clarity**: Clear output showing streaming in real-time
- **Comparison**: Side-by-side performance metrics
- **Extensibility**: Easy to add new models or providers
- **Reliability**: Robust error handling and recovery 