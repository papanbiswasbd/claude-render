# Production Dockerfile for Zeabur / Cloud Platforms
FROM node:20-bookworm-slim

# Install Chromium, FFmpeg, and Bengali/Unicode fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    fonts-beng \
    fonts-beng-extra \
    fonts-noto-core \
    fonts-freefont-ttf \
    fonts-dejavu-core \
    ca-certificates \
    procps \
    git \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PORT=8080 \
    CONCURRENCY=2 \
    NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --production --prefer-offline --no-audit --no-fund

WORKDIR /app/shared-deps
RUN npm init -y && \
    npm install remotion @remotion/cli @remotion/google-fonts react@18.3.1 react-dom@18.3.1 @types/react@18.3.12 typescript@5.6.3 --prefer-offline --no-audit --no-fund

WORKDIR /app

COPY server.js ./
COPY public ./public

EXPOSE 8080

CMD ["node", "server.js"]
