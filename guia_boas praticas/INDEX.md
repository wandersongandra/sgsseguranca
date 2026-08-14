# Prompts e Materiais Operacionais

Esta pasta foi limpa para manter somente arquivos que ainda servem como:

- prompt reutilizavel
- checklist de auditoria
- guia operacional complementar
- utilitario local

## Fonte canonica dos resumos

Os resumos, historicos e passo a passo atualizados do sistema agora ficam em:

- [`../docs/consulta-rapida/README.md`](../docs/consulta-rapida/README.md)
- [`../docs/consulta-rapida/implementacoes-recentes.md`](../docs/consulta-rapida/implementacoes-recentes.md)
- [`../docs/architecture/fluxos-documentais.md`](../docs/architecture/fluxos-documentais.md)
- [`../docs/consulta-rapida/pdfs-finais-e-storage.md`](../docs/consulta-rapida/pdfs-finais-e-storage.md)

Se a duvida for "o que foi implementado?", "como funciona hoje?" ou "onde eu mexo?", consulte `docs/consulta-rapida`.

## O que ficou nesta pasta

### Prompts reutilizaveis

- [`FRONTEND_AUDIT_PROMPT.md`](./FRONTEND_AUDIT_PROMPT.md): prompt de auditoria tecnica do frontend
- [`PROMPT – AUDITORIA BACKEND.md`](./PROMPT%20%E2%80%93%20AUDITORIA%20BACKEND.md): prompt de auditoria tecnica do backend

### Guias e checklists uteis

- [`BOAS-PRATICAS.md`](./BOAS-PRATICAS.md): guia de boas praticas de frontend
- [`DEPLOYMENT_GUIDE.md`](./DEPLOYMENT_GUIDE.md): guia de deploy seguro
- [`README-PRODUCAO.md`](./README-PRODUCAO.md): observacoes de execucao/uso em producao
- [`SECURITY_AUDIT_CHECKLIST.md`](./SECURITY_AUDIT_CHECKLIST.md): checklist de auditoria de seguranca

### Utilitarios locais

- [`git-push.bat`](./git-push.bat)
- [`iniciar.bat`](./iniciar.bat)

## O que foi removido

Foram removidos arquivos redundantes de:

- status antigo
- resumo final duplicado
- celebracao/conclusao historica
- instalacao provisoria
- notas que ja estavam superadas por implementacoes posteriores

Esses conteudos foram consolidados nos docs canonicos do repositorio.

## Regra pratica daqui para frente

- resumos e estado atual do sistema: `docs/consulta-rapida`
- decisoes arquiteturais: `docs/architecture`
- prompts reutilizaveis: `prompts`
- nao recriar multiplos `FINAL_*`, `SUMMARY_*` ou `STATUS_*` quando o assunto ja estiver coberto nos docs canonicos

