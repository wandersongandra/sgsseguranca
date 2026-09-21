import { useEffect, useState } from 'react';
import { selectedTenantStore } from '@/lib/selectedTenantStore';

/**
 * Mantém telas persistentes alinhadas ao tenant selecionado no shell do dashboard.
 * O valor nulo representa o contexto padrão da sessão, não um tenant arbitrário.
 */
export function useSelectedTenantId(): string | null {
  const [tenantId, setTenantId] = useState<string | null>(
    () => selectedTenantStore.get()?.companyId ?? null,
  );

  useEffect(() => {
    const unsubscribe = selectedTenantStore.subscribe((tenant) => {
      setTenantId(tenant?.companyId ?? null);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return tenantId;
}
