'use client';

import { useState, useEffect, useCallback, useDeferredValue, useRef } from 'react';
import { risksService, Risk } from '@/services/risksService';
import { toast } from 'sonner';
import { handleApiError } from '@/lib/error-handler';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';
import { runWithMutationLock } from '@/lib/mutation-lock';

export function useRisks() {
  const [risks, setRisks] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTermState] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(() =>
    selectedTenantStore.get()?.companyId || sessionStore.get()?.companyId || null,
  );
  const deleteMutationLock = useRef(false);

  useEffect(() => {
    const syncActiveCompanyId = () => {
      setActiveCompanyId(
        selectedTenantStore.get()?.companyId ||
          sessionStore.get()?.companyId ||
          null,
      );
    };

    syncActiveCompanyId();
    const unsubscribe = selectedTenantStore.subscribe(syncActiveCompanyId);
    return () => {
      unsubscribe();
    };
  }, []);

  const loadRisks = useCallback(async () => {
    try {
      setLoading(true);
      if (!activeCompanyId) {
        setRisks([]);
        setTotal(0);
        setLastPage(1);
        return;
      }
      const response = await risksService.findPaginated({
        page,
        limit: 10,
        search: deferredSearchTerm || undefined,
        companyId: activeCompanyId,
      });
      setRisks(response.data);
      setTotal(response.total);
      setLastPage(response.lastPage);
    } catch (error) {
      handleApiError(error, 'Riscos');
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, deferredSearchTerm, page]);

  useEffect(() => {
    loadRisks();
  }, [loadRisks]);

  const setSearchTerm = useCallback((value: string) => {
    setSearchTermState(value);
    setPage(1);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (confirm('Tem certeza que deseja excluir este risco?')) {
      await runWithMutationLock(deleteMutationLock, async () => {
        try {
          await risksService.delete(id, activeCompanyId || undefined);
          toast.success('Risco excluído com sucesso!');
          if (risks.length === 1 && page > 1) {
            setPage((current) => current - 1);
            return;
          }
          loadRisks();
        } catch (error) {
          handleApiError(error, 'Riscos');
        }
      });
    }
  }, [activeCompanyId, loadRisks, page, risks.length]);

  return {
    risks,
    loading,
    total,
    page,
    lastPage,
    setPage,
    searchTerm,
    setSearchTerm,
    filteredRisks: risks,
    handleDelete,
    loadRisks,
  };
}
