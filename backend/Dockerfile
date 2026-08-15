# ===============================
# 🏗 STAGE 1 — BUILD
# ===============================
FROM node:22-bookworm AS builder

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

# ===============================
# 🚀 STAGE 2 — RUNTIME
# ===============================
FROM node:22-bookworm-slim

# Dependências mínimas para o Puppeteer gerar PDFs no serviço web.
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
# Thread pool do libuv:
# - default 4 tende a aumentar fila de hash sob login concorrente
# - valores muito altos podem causar pressão de memória em instâncias pequenas
# Começamos em 16 e ajustamos por ambiente via variável do serviço.
ENV UV_THREADPOOL_SIZE=16

WORKDIR /app

# Copia apenas o necessário
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/newrelic.js ./newrelic.js

# Entrypoint genérico para repassar o comando final do serviço
COPY entrypoint.sh ./entrypoint.sh
RUN sed -i 's/\r$//' entrypoint.sh \
  && chmod +x entrypoint.sh \
  && chown -R node:node /app

# Porta dinâmica do provedor (process.env.PORT em runtime)
EXPOSE 8080

USER node

# Liveness probe via /health/ready (rota @Public, retorna 200)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "\
const p=parseInt(process.env.PORT)||8080;\
require('http').get(\
  {hostname:'127.0.0.1',port:p,path:'/health/ready',timeout:8000},\
  r=>process.exit(r.statusCode===200?0:1)\
).on('error',()=>process.exit(1))"


ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/main.js"]
