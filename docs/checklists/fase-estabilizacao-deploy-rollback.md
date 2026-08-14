# Checklist de Fechamento — Fases de Estabilização

## Pré-deploy
- [ ] Confirmar branch `main` atualizado e sem conflitos.
- [ ] Garantir variáveis obrigatórias em produção (DB, Redis, storage, Resend/SMTP, OpenAI, Sentry).
- [ ] Executar no backend:
  - `npm run lint`
  - `npm run build`
  - `npm test`
- [ ] Executar no frontend:
  - `npm run lint`
  - `npm run build`
  - `npm test`
- [ ] Executar e2e crítico de backend:
  - `npm run test:e2e:up`
  - `npm run test:e2e -- --detectOpenHandles --forceExit`
  - `npm run test:e2e:down`

## Deploy
- [ ] Publicar backend e worker com a mesma revisão de commit/tag.
- [ ] Publicar frontend com a mesma revisão de commit/tag.
- [ ] Executar migrations pendentes antes de liberar tráfego:
  - `npm run migration:run`
- [ ] Validar health checks:
  - `GET /health/public`
  - `GET /health`

## Pós-deploy (smoke operacional)
- [ ] Login + refresh token + logout.
- [ ] Fluxo APR completo (criar, editar, finalizar, PDF).
- [ ] Central de pendências e ações operacionais.
- [ ] Envio de e-mail real (Resend/SMTP).
- [ ] Fluxo de assinatura verificável e validação pública.
- [ ] DR administrativo:
  - backup manual de tenant
  - listagem de backups
  - restore validado em ambiente de recuperação

## Rollback
- [ ] Congelar novas mudanças no deploy pipeline.
- [ ] Reverter backend/worker/frontend para a última tag estável.
- [ ] Se houver migração incompatível, aplicar plano de reversão de schema.
- [ ] Revalidar health checks e smoke crítico.
- [ ] Registrar incidente com timestamp, impacto, causa e ação corretiva.

## Evidências mínimas para auditoria
- [ ] Hash do commit e tag publicada.
- [ ] Logs de lint/build/test/e2e.
- [ ] Resultado de backup/restore (job id + status).
- [ ] Registro de aprovação operacional do release.
