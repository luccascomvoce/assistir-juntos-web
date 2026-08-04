FROM node:22-alpine

# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY server/package.json .
RUN npm install --production

# Runtime stage
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules /app/node_modules
COPY server/ /app/

RUN mkdir -p /app/videos /app/uploads /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV VIDEOS_DIR=/app/videos
ENV TOKENS_PATH=/app/data/tokens.json

CMD ["node", "index.js"]