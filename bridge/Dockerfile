# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# Runtime stage
FROM node:20-slim

WORKDIR /app

# Install claude-code-acp globally
RUN npm install -g @zed-industries/claude-code-acp

# Copy built app and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Default port
ENV OOK_PORT=8647
EXPOSE 8647

# Run as non-root
USER node

CMD ["node", "dist/index.js"]
