FROM node:20-slim

# Install native dependencies for sharp, better-sqlite3, and unrar for RAR5 support
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    unrar-free \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application code
COPY server/ ./server/
COPY public/ ./public/

# Data directory for SQLite DB, thumbnails, cache
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3131

EXPOSE 3131

CMD ["node", "server/index.js"]
