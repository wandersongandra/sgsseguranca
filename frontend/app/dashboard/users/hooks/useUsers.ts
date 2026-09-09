import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { usersService, User, UserIdentityType } from '@/services/usersService';
import { handleApiError } from '@/lib/error-handler';
import { toast } from 'sonner';
import { authService } from '@/services/authService';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';
import { useSelectedTenantId } from '@/hooks/useSelectedTenantId';

type PendingDeleteAction = 'gdpr_erasure' | 'hard_delete';

function resolveActiveCompanyId(): string | undefined {
  return selectedTenantStore.get()?.companyId || sessionStore.get()?.companyId || undefined;
}

export function useUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [stepUpValue, setStepUpValue] = useState('');
  const [pendingDeleteAction, setPendingDeleteAction] =
    useState<PendingDeleteAction>('gdpr_erasure');
  const tenantId = useSelectedTenantId();
  const activeCompanyId = tenantId || sessionStore.get()?.companyId || undefined;
  const requestSeqRef = useRef(0);
  const destructiveOperationSeqRef = useRef(0);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const scope = activeCompanyId ?? null;
    try {
      setLoading(true);
      const res = await usersService.findPaginated({
        page,
        limit,
        identityType: UserIdentityType.SYSTEM_USER,
        companyId: activeCompanyId,
      });
      if (seq !== requestSeqRef.current) return;
      setUsers(res.data);
      setTotal(res.total);
      setLastPage(res.lastPage);
      setLoadedScope(scope);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      handleApiError(error, 'Usuários');
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [activeCompanyId, page, limit]);

  useEffect(() => {
    requestSeqRef.current += 1;
    destructiveOperationSeqRef.current += 1;
    setUsers([]);
    setTotal(0);
    setLastPage(1);
    setLoadedScope(null);
    setLoading(true);
    setDeleteLoading(false);
    setPage(1);
    setConfirmDeleteId(null);
    setStepUpValue('');
  }, [tenantId]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const requestGdprErase = useCallback((id: string) => {
    setPendingDeleteAction('gdpr_erasure');
    setConfirmDeleteId(id);
  }, []);

  const requestHardDelete = useCallback((id: string) => {
    setPendingDeleteAction('hard_delete');
    setConfirmDeleteId(id);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!confirmDeleteId) return;

    const operationCompanyId = resolveActiveCompanyId();
    const targetUserId = confirmDeleteId;
    const action = pendingDeleteAction;
    const operationSeq = ++destructiveOperationSeqRef.current;

    if (!operationCompanyId) {
      toast.error('Operação cancelada porque não há empresa ativa.');
      return;
    }

    setDeleteLoading(true);
    try {
      const trimmed = stepUpValue.trim();
      if (!trimmed) {
        toast.error('Confirme com senha ou código MFA.');
        return;
      }

      const reason = action === 'hard_delete' ? 'user_delete' : 'user_gdpr_erasure';
      const stepUp = /^\d{6,8}$/.test(trimmed)
        ? await authService.verifyStepUp({
            reason,
            code: trimmed,
          })
        : await authService.verifyStepUp({
            reason,
            password: trimmed,
          });

      if (
        operationSeq !== destructiveOperationSeqRef.current ||
        resolveActiveCompanyId() !== operationCompanyId
      ) {
        toast.error('Operação cancelada porque a empresa ativa foi alterada.');
        return;
      }

      if (action === 'hard_delete') {
        await usersService.delete(targetUserId, stepUp.stepUpToken, operationCompanyId);
        setUsers((prev) => prev.filter((u) => u.id !== targetUserId));
        toast.success('Usuário excluído definitivamente.');
      } else {
        await usersService.gdprErasure(targetUserId, stepUp.stepUpToken, operationCompanyId);
        setUsers((prev) => prev.filter((u) => u.id !== targetUserId));
        toast.success('Dados anonimizados e usuário desativado!');
      }
      setConfirmDeleteId(null);
      setStepUpValue('');
    } catch (error) {
      handleApiError(error, 'Usuário');
    } finally {
      if (operationSeq === destructiveOperationSeqRef.current) {
        setDeleteLoading(false);
      }
    }
  }, [confirmDeleteId, pendingDeleteAction, stepUpValue]);

  const scopedUsers = useMemo(
    () => (loadedScope === (activeCompanyId ?? null) ? users : []),
    [activeCompanyId, loadedScope, users],
  );
  const scopedTotal = loadedScope === (activeCompanyId ?? null) ? total : 0;
  const scopedLastPage = loadedScope === (activeCompanyId ?? null) ? lastPage : 1;

  const filteredUsers = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return scopedUsers.filter(
      (user) =>
        (user.nome ?? '').toLowerCase().includes(term) ||
        (user.cpf ?? '').includes(term) ||
        (user.email ?? '').toLowerCase().includes(term),
    );
  }, [scopedUsers, searchTerm]);

  return {
    users: scopedUsers,
    loading,
    filteredUsers,
    searchTerm,
    setSearchTerm,
    page,
    setPage,
    limit,
    total: scopedTotal,
    lastPage: scopedLastPage,
    requestGdprErase,
    requestHardDelete,
    confirmDelete,
    confirmDeleteId,
    setConfirmDeleteId,
    deleteLoading,
    stepUpValue,
    setStepUpValue,
    pendingDeleteAction,
    loadUsers,
  };
}
