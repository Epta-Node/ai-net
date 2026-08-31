FROM node:20-alpine AS builder

WORKDIR /app

# Copy root and backend package definitions for npm workspace / monorepo support
COPY package*.json ./
COPY backend/package*.json ./backend/

RUN npm install --workspace=backend

COPY tsconfig.json ./
COPY backend/ ./backend/

WORKDIR /app/backend
RUN npm run build || true

FROM node:20-alpine AS runner

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/backend /app/backend

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["npm", "start"]
