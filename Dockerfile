# Multi-stage build for smaller production image
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY backend/package*.json ./backend/

# Install dependencies
RUN npm install && cd backend && npm install

# Copy source code
COPY . .

# Build frontend
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy built frontend (dashboard SPA)
COPY --from=builder /app/dist ./dist

# Copy built widget bundle (served at /widget/v<version>.js)
COPY --from=builder /app/widget/dist ./widget/dist

# Copy backend code
COPY --from=builder /app/backend ./backend

# npm workspaces hoist to the root node_modules — copy that, not backend's.
# Node module resolution walks up from backend/ so backend code finds deps here.
COPY --from=builder /app/node_modules ./node_modules

# Copy package metadata (needed by node:sqlite + workspace resolution)
COPY package*.json ./

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:8000/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

# Run server
CMD ["node", "--experimental-sqlite", "backend/server.js"]
