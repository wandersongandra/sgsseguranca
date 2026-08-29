# ===============================
# 🏗 STAGE 1 — BUILD
# ===============================
FROM node:22-bookworm AS builder

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=development

COPY backend/package*.json ./
COPY backend/scripts ./scripts
RUN npm ci --include=dev

COPY backend/. .
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

# ===============================
# 🚀 STAGE 2 — RUNTIME
# ===============================
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libu2f-udev \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libasound2 \
    xdg-utils \
  || (apt-get update --fix-missing && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libu2f-udev \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libasound2 \
    xdg-utils) \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp/.chromium-config
ENV XDG_CACHE_HOME=/tmp/.chromium-cache
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV UV_THREADPOOL_SIZE=16

WORKDIR /app

COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/src/modules/sophie/kb ./dist/modules/sophie/kb
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/migration-history-compatibility.json ./migration-history-compatibility.json
COPY --from=builder --chown=node:node /app/newrelic.js ./newrelic.js

COPY --chown=node:node backend/entrypoint.sh ./entrypoint.sh
RUN sed -i 's/\r$//' entrypoint.sh \
  && chmod +x entrypoint.sh

# Mesmo motivo do Dockerfile.worker: TenantBackupService e outras rotinas
# que escrevem em ./output precisam do diretório pré-criado com owner node.
RUN mkdir -p /app/output && chown node:node /app/output

EXPOSE 8080

USER node

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/main.js"]
