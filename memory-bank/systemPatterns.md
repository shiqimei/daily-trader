# System Patterns: AI Streaming Architecture

## Architecture Overview

```
daily-trader/
├── src/
│   ├── config.ts                 # Environment & configuration management
│   ├── services/
│   │   ├── bedrockService.ts     # AWS Bedrock streaming service
│   │   └── openaiService.ts      # OpenAI streaming service
│   └── main.ts                   # Test suite & demonstration
├── memory-bank/                  # Project documentation
├── .env                          # Environment variables (gitignored)
├── .env.example                  # Environment template
└── package.json                  # Project configuration
```

## Key Technical Decisions

### Service Layer Pattern
- **Separation of Concerns**: Each AI provider has its own service class
- **Consistent Interface**: Both services expose similar streaming methods
- **Async Iterables**: Use modern async iteration for streaming responses
- **Error Isolation**: Provider-specific error handling within each service

### Configuration Management
- **Centralized Config**: Single `config.ts` file manages all environment variables
- **Validation**: Required environment variables throw errors if missing
- **Type Safety**: Strong TypeScript interfaces for configuration structure
- **Defaults**: Sensible defaults for optional configuration values

### Streaming Implementation
- **AsyncIterable Pattern**: Return async iterables for consistent streaming interface
- **Chunk Processing**: Parse streaming responses into text chunks
- **Real-time Output**: Use `process.stdout.write()` for immediate display
- **Performance Metrics**: Track timing, chunk count, and content length

## Design Patterns

### Factory Pattern (Services)
- Service classes instantiate their respective API clients
- Configuration injected via constructor
- Clean separation between service logic and API clients

### Template Method (Streaming)
- Common streaming interface across different providers
- Provider-specific implementation details hidden
- Consistent error handling and response parsing

### Strategy Pattern (Model Selection)
- Convenience methods for different models (Sonnet, Opus, GPT-3.5, GPT-4)
- Easy switching between models without changing client code
- Extensible for adding new models

## Component Relationships

### Dependencies Flow
```
main.ts → BedrockService → AWS SDK
main.ts → OpenAIService → OpenAI SDK
Services → config.ts → dotenv → .env
```

### Data Flow
```
User Input → Service Classes → API Clients → Streaming Response → Async Iterator → Console Output
```

## Error Handling Strategy

- **Graceful Degradation**: Tests continue even if one provider fails
- **Detailed Error Messages**: Clear indication of what went wrong
- **Provider Isolation**: Failure in one service doesn't affect others
- **User-Friendly Output**: Error messages include actionable information 