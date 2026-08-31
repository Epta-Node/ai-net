FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY frontend/package*.json ./frontend/

RUN npm install --workspace=frontend

COPY frontend/ ./frontend/

WORKDIR /app/frontend
RUN npm run build || true

FROM node:20-alpine AS runner

WORKDIR /app/frontend

ENV NODE_ENV=production
ENV PORT=5173

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/frontend /app/frontend

EXPOSE 5173

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
