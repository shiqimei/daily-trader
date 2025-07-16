# Claude Code Guidelines for Agent-Centric Binance Futures Trading Bot

## Project Overview

Agent-centric trading bot that provides MCP (Model Context Protocol) tools to LLMs for intelligent trading decisions in Binance futures markets. The LLM agents analyze market context and make autonomous trading decisions while adhering to safety constraints.

## Architecture Principles

- Agent-Centric Design: LLMs as primary decision makers
- MCP Tool Pattern: APIs exposed as structured tools for LLM consumption
- Object-Oriented Programming (OOP)
- SOLID principles
- Domain-Driven Design (DDD)
- Clean Architecture with clear separation of concerns
- Context-First: Provide rich market context to agents

## Code Standards

- Type hints for all function parameters and returns
- Dataclasses for DTOs and value objects
- Abstract base classes for interfaces
- Dependency injection for testability
- Async/await for all I/O operations
- Proper error handling with custom exceptions
- Comprehensive logging

## Testing Requirements

- Unit tests for all business logic
- Integration tests for API interactions
- Minimum 80% code coverage

### Test Types

- **Unit Tests**: Fast, isolated tests with mocked dependencies
- **Integration Tests**: Real API calls to validate response shapes and API compatibility
- **Integration tests require environment variables**: BINANCE_FUTURES_API_KEY and BINANCE_FUTURES_API_SECRET

## Documentation

- Docstrings for all public methods
- README.md for each package explaining interfaces
- Type annotations serve as inline documentation

## Security

- Never log sensitive data (API keys, secrets)
- Use environment variables for configuration
- Validate all external inputs
- Rate limiting awareness

## Authentication

- **Default**: HMAC-SHA256 (standard Binance API authentication)

## Performance

- Efficient WebSocket message handling
- Minimal latency for order operations
- Proper connection management and reconnection logic
- Memory-efficient data structures for orderbook

## MCP Server Development Guidelines

### Tool Design Principles

- **Clear Intent**: Tool names and descriptions must clearly convey their purpose
- **Rich Context**: Tools should return comprehensive data for agent understanding
- **Safety First**: All trading tools must have built-in risk checks
- **Stateless**: Tools should be stateless where possible for predictability
- **Error Transparency**: Return clear error messages that agents can understand

### Tool Categories

1. **Information Tools** (Read-only)

   - Market data retrieval
   - Account status queries
   - Historical data access
   - Should never modify state

2. **Action Tools** (State-changing)

   - Order placement/cancellation
   - Position management
   - Must include confirmation/validation steps
   - Should return action results clearly

3. **Analysis Tools** (Computation)
   - Technical indicators
   - Risk calculations
   - Market metrics
   - Should be deterministic

### Agent Context Management

- Maintain conversation history for context
- Track agent decisions and outcomes
- Provide market state summaries
- Include relevant risk metrics in all responses

### Safety Controls for Agent Trading

1. **Position Limits**: Enforce maximum position sizes
2. **Rate Limiting**: Prevent excessive order placement
3. **Risk Checks**: Validate orders against account balance
4. **Circuit Breakers**: Stop trading on anomalous behavior
5. **Audit Trail**: Log all agent decisions and actions

## Coding Style

- Avoid any emojis in the code - remember this rule
- Never create new files with version suffixes (test*, enhanced*, improved*, new*, optimized\_, v2, etc.) when existing files exist
- Always update existing files directly instead of creating versioned copies
- When fixing or improving code, modify the original file rather than creating alternatives
- MCP tools should have descriptive, action-oriented names (e.g., `get_market_depth`, `place_limit_order`)

## MCP Server stdio Guidelines

- **NEVER use console.log() or console.error()** in MCP servers using stdio transport
- stdio transport uses stdout/stderr for protocol communication
- Any console output will corrupt the JSON-RPC messages
- Use the MCP server's built-in error handling instead
- For debugging, write to a file or use a separate logging mechanism
