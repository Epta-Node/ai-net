FROM node:24-alpine AS builder

WORKDIR /app/backend

# The repo is not an npm workspace, so install from backend's own lockfile.
# --ignore-scripts: better-sqlite3 ships linuxmusl prebuilds, so its node-gyp
# fallback (which needs python/make/g++) is never needed.
COPY backend/package*.json ./
RUN npm ci --ignore-scripts

COPY backend/ ./

# Build fails the image if TypeScript compilation fails — no || true suppression.
RUN npm run build

FROM node:24-alpine AS runner

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=3000

# Install production-only dependencies
COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/scripts ./scripts

# Run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# SQLite, event store and backups default to ./data (a named volume mounted
# there inherits this ownership on first use); auth.db is written to the cwd.
# Non-recursive chown, so the code itself stays root-owned.
RUN mkdir -p data && chown appuser:appgroup . data
USER appuser

EXPOSE 3000

# Liveness only: /health/live never touches upstreams, so a Venice or Horizon
# outage cannot flap the container. Gate traffic on /health/deep instead (503
# when a critical dependency is failing) — see docs/API_REFERENCE.md.
HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health/live || exit 1

CMD ["node", "dist/src/index.js"]
