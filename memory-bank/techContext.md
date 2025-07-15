# Technical Context: Development Environment & Dependencies

## Technologies Used

### Core Technologies
- **Node.js**: JavaScript runtime (latest LTS recommended)
- **TypeScript**: Type-safe JavaScript development
- **pnpm**: Fast, disk space efficient package manager

### Primary Dependencies
- **openai**: Official OpenAI API client library
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
2. Configure AWS credentials:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION` (default: us-east-1)
3. Configure OpenAI API key:
   - `OPENAI_API_KEY`

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

### API Rate Limits
- **AWS Bedrock**: Model-specific limits (check AWS console)
- **OpenAI**: Tier-based rate limits
- **Recommendation**: Implement rate limiting for production use

### Model Availability
- **AWS Bedrock**: Regional availability varies
- **Model Access**: May require requesting access to specific models
- **Fallback Strategy**: Handle model unavailability gracefully

### Memory & Performance
- **Streaming**: Low memory footprint due to streaming approach
- **Concurrent Requests**: Current implementation is sequential
- **Optimization**: Consider connection pooling for high throughput

## Dependencies Management

### Version Strategy
- **Exact Versions**: All dependencies pinned to exact versions
- **Security Updates**: Regular dependency auditing recommended
- **Compatibility**: AWS SDK and OpenAI SDK evolve frequently

### Package Manager Features
- **pnpm Workspaces**: Ready for monorepo if needed
- **Peer Dependencies**: Automatically handled by pnpm
- **Lock File**: `pnpm-lock.yaml` ensures reproducible builds

## Build & Deployment

### TypeScript Configuration
- **Target**: ES2016 for broad compatibility
- **Module**: CommonJS for Node.js compatibility
- **Strict Mode**: Enabled for type safety
- **Source Maps**: Available for debugging

### Production Considerations
- **Environment Variables**: Use secure secret management
- **Error Monitoring**: Implement structured logging
- **Health Checks**: Add endpoint for service monitoring
- **Containerization**: Dockerfile ready for Docker deployment 