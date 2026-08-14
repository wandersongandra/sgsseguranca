import { useState, useEffect, useMemo, useCallback } from 'react';
import { usersService, User, UserIdentityType } from '@/services/usersService';
import { handleApiError } from '@/lib/error-handler';
import { toast } from 'sonner';
import { authService } from '@/services/authService';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';

type PendingDeleteAction = 'gdpr_erasure' | 'hard_delete';

function resolveActiveCompanyId(): string | undefined {
  return (
    selectedTenantStore.get()?.companyId ||
    sessionStore.get()?.companyId ||
    undefined
  );
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

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await usersService.findPaginated({
        page,
        limit,
        identityType: UserIdentityType.SYSTEM_USER,
      });
      setUsers(res.data);
      setTotal(res.total);
      setLastPage(res.lastPage);
    } catch (error) {
      handleApiError(error, 'Usuários');
    } finally {
      setLoading(false);
    }
  }, [page, limit]);

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
    setDeleteLoading(true);
    try {
      const trimmed = stepUpValue.trim();
      if (!trimmed) {
        toast.error('Confirme com senha ou código MFA.');
        return;
      }

      const reason =
        pendingDeleteAction === 'hard_delete'
          ? 'user_delete'
          : 'user_gdpr_erasure';
      const stepUp =
        /^\d{6,8}$/.test(trimmed)
          ? await authService.verifyStepUp({
              reason,
              code: trimmed,
            })
          : await authService.verifyStepUp({
              reason,
              password: trimmed,
            });

      if (pendingDeleteAction === 'hard_delete') {
        await usersService.delete(
          confirmDeleteId,
          stepUp.stepUpToken,
          resolveActiveCompanyId(),
        );
        setUsers((prev) => prev.filter((u) => u.id !== confirmDeleteId));
        toast.success('Usuário excluído definitivamente.');
      } else {
        await usersService.gdprErasure(
          confirmDeleteId,
          stepUp.stepUpToken,
          resolveActiveCompanyId(),
        );
        setUsers((prev) => prev.filter((u) => u.id !== confirmDeleteId));
        toast.success('Dados anonimizados e usuário desativado!');
      }
      setConfirmDeleteId(null);
      setStepUpValue('');
    } catch (error) {
      handleApiError(error, 'Usuário');
    } finally {
      setDeleteLoading(false);
    }
  }, [confirmDeleteId, pendingDeleteAction, stepUpValue]);

  const filteredUsers = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return users.filter(user =>
      (user.nome ?? '').toLowerCase().includes(term) ||
      (user.cpf ?? '').includes(term) ||
      (user.email ?? '').toLowerCase().includes(term)
    );
  }, [users, searchTerm]);

  return {
    users,
    loading,
    filteredUsers,
    searchTerm,
    setSearchTerm,
    page,
    setPage,
    limit,
    total,
    lastPage,
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
