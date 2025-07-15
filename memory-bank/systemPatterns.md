# System Patterns: AWS Bedrock Streaming Architecture

## Architecture Overview

```
daily-trader/
├── src/
│   ├── config.ts                 # Environment & bearer token configuration
│   ├── services/
│   │   └── bedrockService.ts     # AWS Bedrock streaming service
│   └── main.ts                   # Claude model test suite
├── memory-bank/                  # Project documentation
├── .env                          # Bearer token configuration (gitignored)
├── .env.example                  # Environment template
└── package.json                  # Project configuration
```

## Key Technical Decisions

### Service Layer Pattern
- **Single Provider Focus**: BedrockService handles all Claude model interactions
- **Model-Specific Methods**: Separate methods for Claude Sonnet and Opus
- **Async Iterables**: Use modern async iteration for streaming responses
- **Bearer Token Auth**: Secure authentication using AWS bearer tokens

### Configuration Management
- **Centralized Config**: Single `config.ts` file manages bearer token and model configuration
- **Token Validation**: Required bearer token throws error if missing
- **Type Safety**: Strong TypeScript interfaces for configuration structure
- **Model Defaults**: Sensible defaults for Claude model IDs

### Streaming Implementation
- **AsyncIterable Pattern**: Return async iterables for consistent streaming interface
- **Chunk Processing**: Parse Claude streaming responses into text chunks
- **Real-time Output**: Use `process.stdout.write()` for immediate display
- **Performance Metrics**: Track timing, chunk count, character count, and word estimates

## Design Patterns

### Factory Pattern (Service)
- BedrockService instantiates AWS SDK client with bearer token
- Configuration injected via constructor
- Clean separation between service logic and AWS SDK

### Template Method (Streaming)
- Common streaming interface for different Claude models
- Model-specific implementation details handled internally
- Consistent error handling and response parsing

### Strategy Pattern (Model Selection)
- Convenience methods for different models (Sonnet, Opus)
- Easy switching between models without changing client code
- Extensible for adding new Claude models

## Component Relationships

### Dependencies Flow
```
main.ts → BedrockService → AWS SDK
BedrockService → config.ts → dotenv → .env
```

### Data Flow
```
User Input → BedrockService → AWS Bedrock API → Streaming Response → Async Iterator → Console Output
```

## Authentication Strategy

### Bearer Token Implementation
- **Token Storage**: Secure storage in environment variables
- **AWS SDK Integration**: Token passed as sessionToken to AWS credentials
- **Error Handling**: Clear messages for invalid or missing tokens
- **Security**: No token logging or exposure in error messages

## Error Handling Strategy

- **Model Isolation**: Different Claude models can fail independently
- **Detailed Error Messages**: Clear indication of authentication or model issues
- **Token Security**: Error messages don't expose bearer token values
- **User-Friendly Output**: Error messages include actionable information 