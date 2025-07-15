# Technical Context: AWS Bedrock Development Environment

## Technologies Used

### Core Technologies
- **Node.js**: JavaScript runtime (latest LTS recommended)
- **TypeScript**: Type-safe JavaScript development
- **pnpm**: Fast, disk space efficient package manager

### Primary Dependencies
- **@aws-sdk/client-bedrock-runtime**: AWS SDK for Bedrock streaming
- **dotenv**: Environment variable management

### Development Dependencies
- **tsx**: TypeScript execution for development
- **nodemon**: File watching and auto-restart
- **@types/node**: Node.js type definitions

## Development Setup

### Prerequisites
```bash
# Node.js (18+ recommended)
node --version

# pnpm (installed globally)
npm install -g pnpm
```

### Environment Configuration
1. Copy `.env.example` to `.env`
2. Configure AWS Bearer Token:
   - `AWS_BEARER_TOKEN_BEDROCK`
3. Optional model configuration:
   - `BEDROCK_CLAUDE_SONNET_MODEL_ID`
   - `BEDROCK_CLAUDE_OPUS_MODEL_ID`

### Available Scripts
```bash
# Development (with TypeScript execution)
pnpm dev

# Development with auto-restart
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

## Technical Constraints

### AWS Bedrock Limitations
- **Bearer Token**: Must have valid AWS bearer token with Bedrock permissions
- **Model Access**: May require requesting access to specific Claude models
- **Regional Availability**: Claude models available in specific AWS regions
- **Rate Limits**: Model-specific rate limits (check AWS console)

### Authentication Requirements
- **Bearer Token Format**: Must be valid AWS bearer token
- **Permissions**: Token must have Bedrock invoke permissions
- **Security**: Token should be kept secure and not logged

### Memory & Performance
- **Streaming**: Low memory footprint due to streaming approach
- **Sequential Requests**: Current implementation tests models sequentially
- **Optimization**: Consider connection reuse for high throughput

## Dependencies Management

### Version Strategy
- **Exact Versions**: All dependencies pinned to exact versions
- **Security Updates**: Regular dependency auditing recommended
- **AWS SDK**: AWS SDK evolves frequently, monitor for updates

### Package Manager Features
- **pnpm Efficiency**: Fast installation and efficient disk usage
- **Lock File**: `pnpm-lock.yaml` ensures reproducible builds
- **Reduced Dependencies**: Minimal dependency footprint with Bedrock-only focus

## Build & Deployment

### TypeScript Configuration
- **Target**: ES2016 for broad compatibility
- **Module**: CommonJS for Node.js compatibility
- **Strict Mode**: Enabled for type safety
- **Source Maps**: Available for debugging

### Production Considerations
- **Bearer Token Security**: Use secure secret management systems
- **Error Monitoring**: Implement structured logging
- **Health Checks**: Add endpoint for service monitoring
- **Containerization**: Dockerfile ready for Docker deployment

## Bearer Token Management

### Token Security
- **Environment Variables**: Store token in .env file (gitignored)
- **No Logging**: Never log or expose bearer token values
- **Rotation**: Implement token rotation policies
- **Access Control**: Limit token permissions to minimum required

### Token Configuration
- **AWS CLI**: Can obtain token using AWS CLI
- **IAM Roles**: Prefer IAM roles for production deployments
- **Temporary Tokens**: Support for temporary session tokens
- **Validation**: Token validation happens at AWS API level 