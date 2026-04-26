FROM node:20-slim

# Install native dependencies for sharp, better-sqlite3, and unrar for RAR5 support.
# Real `unrar` (not `unrar-free`) is required: unrar-free doesn't support RAR5 and
# rejects the `lb` flag the parser uses. It lives in Debian's non-free repo, so we
# enable non-free in the existing deb822 sources file (adding a separate .list would
# conflict with the keyring already declared in debian.sources).
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    unrar \
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
