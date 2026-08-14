# 🚀 Frontend - Guia de Produção

## 📋 Modos de Execução

### Desenvolvimento
```bash
npm run dev
```
- Hot reload ativo
- Turbopack habilitado
- Porta: 3000

### Produção (Local)
```bash
npm run build
npm start
```
- Build otimizado
- Sem hot reload
- Porta: 3000

### Produção (Docker/Standalone)
```bash
# 1. Habilitar standalone no next.config.ts
# Descomentar: output: 'standalone'

# 2. Build
npm run build

# 3. Executar
node .next/standalone/server.js
```

---

## 🐳 Docker

### Dockerfile Otimizado

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Build
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  frontend:
    build: .
    restart: always
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - NEXT_PUBLIC_API_URL=http://backend:3001
    depends_on:
      - backend
    networks:
      - app_network

networks:
  app_network:
    driver: bridge
```

---

## ⚙️ Configuração

### Variáveis de Ambiente

Criar `.env.production`:

```env
# API Backend
NEXT_PUBLIC_API_URL=https://api.seu-dominio.com

# Analytics (opcional)
NEXT_PUBLIC_GA_ID=G-XXXXXXXXXX

# Feature Flags
NEXT_PUBLIC_ENABLE_ANALYTICS=true
NEXT_PUBLIC_ENABLE_PWA=false

# Sentry (opcional)
NEXT_PUBLIC_SENTRY_DSN=https://...
```

---

## 🔧 Otimizações

### 1. Compression

Já habilitado via headers no `next.config.ts`:
- GZIP automático
- Brotli para assets estáticos

### 2. Caching

Headers de cache configurados:
- Assets estáticos: 1 ano
- HTML: sem cache
- API calls: cache customizado

### 3. Security Headers

Já configurados:
- ✅ Strict-Transport-Security
- ✅ X-Frame-Options
- ✅ X-Content-Type-Options
- ✅ Content-Security-Policy
- ✅ Permissions-Policy

### 4. Image Optimization

```tsx
import Image from 'next/image';

<Image
  src="/logo.png"
  alt="Logo"
  width={200}
  height={50}
  priority // Para imagens above-the-fold
  quality={85} // 85 é bom balanço
/>
```

### 5. Code Splitting

Automático no Next.js, mas pode otimizar:

```tsx
import dynamic from 'next/dynamic';

// Lazy load de componentes pesados
const HeavyComponent = dynamic(() => import('./HeavyComponent'), {
  loading: () => <p>Carregando...</p>,
  ssr: false, // Desabilitar SSR se não necessário
});
```

---

## 📊 Performance

### Métricas Alvo

- First Contentful Paint (FCP): < 1.8s
- Largest Contentful Paint (LCP): < 2.5s
- Time to Interactive (TTI): < 3.8s
- Cumulative Layout Shift (CLS): < 0.1
- First Input Delay (FID): < 100ms

### Lighthouse Score

Alvo: 90+ em todas categorias
- Performance: 90+
- Accessibility: 90+
- Best Practices: 90+
- SEO: 90+

### Testar Performance

```bash
# Lighthouse CLI
npm install -g lighthouse
lighthouse http://localhost:3000 --view

# Next.js Bundle Analyzer
npm install @next/bundle-analyzer
```

---

## 🚀 Deploy

### Vercel (Recomendado)

```bash
# Instalar Vercel CLI
npm install -g vercel

# Deploy
vercel

# Deploy para produção
vercel --prod
```

### AWS (S3 + CloudFront)

```bash
# Build
npm run build

# Upload para S3
aws s3 sync out/ s3://seu-bucket --delete

# Invalidar CloudFront
aws cloudfront create-invalidation --distribution-id XXX --paths "/*"
```

### Nginx (Self-hosted)

```nginx
server {
    listen 80;
    server_name seu-dominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 🐛 Troubleshooting

### Erro: "next start" não funciona com standalone

**Solução**: Use `node .next/standalone/server.js`

### Erro: Module not found

**Solução**: 
```bash
rm -rf .next node_modules
npm install
npm run build
```

### Erro: Port 3000 already in use

**Solução**:
```bash
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Linux/Mac
lsof -ti:3000 | xargs kill -9
```

### Build muito lento

**Solução**:
```bash
# Limpar cache
rm -rf .next

# Usar Turbopack (dev only)
npm run dev --turbo
```

---

## 📦 Bundle Size

### Analisar Bundle

```bash
# Instalar analyzer
npm install @next/bundle-analyzer

# Adicionar ao next.config.ts
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});

module.exports = withBundleAnalyzer(nextConfig);

# Executar análise
ANALYZE=true npm run build
```

### Reduzir Bundle

1. **Tree Shaking**: Importar apenas o necessário
```tsx
// ❌ Ruim
import _ from 'lodash';

// ✅ Bom
import debounce from 'lodash/debounce';
```

2. **Dynamic Imports**: Lazy load
```tsx
const Chart = dynamic(() => import('recharts'), { ssr: false });
```

3. **Remove unused dependencies**
```bash
npm install -g depcheck
depcheck
```

---

## 🔒 Segurança

### 1. Environment Variables

Nunca commitar `.env` com valores reais:
```bash
# .gitignore
.env
.env.local
.env.production
```

### 2. API Keys

Usar apenas `NEXT_PUBLIC_` para variáveis públicas:
```env
# ✅ Público (vai para o browser)
NEXT_PUBLIC_API_URL=https://api.com

# ❌ Privado (não usar NEXT_PUBLIC_)
API_SECRET_KEY=secret123
```

### 3. CSP (Content Security Policy)

Já configurado no `next.config.ts`, mas ajuste conforme necessário.

---

## 📚 Recursos

- [Next.js Docs](https://nextjs.org/docs)
- [Next.js Examples](https://github.com/vercel/next.js/tree/canary/examples)
- [Vercel Deploy](https://vercel.com/docs)
- [Performance Best Practices](https://nextjs.org/docs/pages/building-your-application/optimizing)

---

## ✅ Checklist de Produção

- [ ] Build sem erros
- [ ] Lighthouse score 90+
- [ ] Security headers configurados
- [ ] Environment variables configuradas
- [ ] Error tracking (Sentry) configurado
- [ ] Analytics configurado
- [ ] Backup configurado
- [ ] Monitoring configurado
- [ ] CDN configurado
- [ ] SSL/HTTPS ativo

---

**Pronto para produção! 🚀**
