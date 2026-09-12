'use client';

import { selectedTenantStore } from './selectedTenantStore';
import { sessionStore } from './sessionStore';

/**
 * companyId ativo do usuário atual.
 *
 * selectedTenantStore só é populado quando um usuário admin_geral escolhe
 * uma empresa no seletor de tenant — persistAuthenticatedSession limpa esse
 * store incondicionalmente em TODO login (auth-session-state.ts), inclusive
 * para usuários de empresa única. Para eles, o tenant real vive em
 * sessionStore (derivado do JWT). Sem este fallback, qualquer tela/hook que
 * leia apenas selectedTenantStore trata usuários fora do admin_geral como
 * "sem empresa ativa" — usado por useAprs.ts, useUsers.ts e
 * app/dashboard/layout.tsx (banner de seleção de obra).
 */
export function resolveActiveCompanyId(): string | undefined {
  return (
    selectedTenantStore.get()?.companyId ||
    sessionStore.get()?.companyId ||
    undefined
  );
}
