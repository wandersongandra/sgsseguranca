import { renderHook, waitFor, act } from '@testing-library/react';
import { toast } from 'sonner';

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock('@/lib/error-handler', () => ({
  handleApiError: jest.fn(),
}));

jest.mock('@/lib/sessionStore', () => ({
  sessionStore: {
    get: jest.fn(() => ({ companyId: 'company-x' })),
  },
}));

let mockTenantListener:
  ((tenant: { companyId: string; companyName: string } | null) => void) | undefined;

jest.mock('@/lib/selectedTenantStore', () => ({
  selectedTenantStore: {
    get: jest.fn(() => ({ companyId: 'company-x', companyName: 'Empresa X' })),
    subscribe: jest.fn((listener) => {
      mockTenantListener = listener;
      return () => {
        if (mockTenantListener === listener) {
          mockTenantListener = undefined;
        }
      };
    }),
  },
}));

jest.mock('@/services/authService', () => ({
  authService: {
    verifyStepUp: jest.fn(),
  },
}));

jest.mock('@/services/usersService', () => ({
  usersService: {
    findPaginated: jest.fn(),
    delete: jest.fn(),
    gdprErasure: jest.fn(),
  },
  UserIdentityType: {
    SYSTEM_USER: 'system_user',
    EMPLOYEE_SIGNER: 'employee_signer',
  },
}));

import { useUsers } from './useUsers';
import { usersService, UserIdentityType } from '@/services/usersService';
import { authService } from '@/services/authService';
import type { User as UserType } from '@/services/usersService';

const findPaginatedMock = usersService.findPaginated as jest.Mock;
const hardDeleteMock = usersService.delete as jest.Mock;
const gdprErasureMock = usersService.gdprErasure as jest.Mock;
const verifyStepUpMock = authService.verifyStepUp as jest.Mock;

function makeUser(overrides: Partial<UserType> = {}): UserType {
  return {
    id: 'user-1',
    nome: 'Fulano',
    email: 'fulano@example.com',
    cpf: '12345678900',
    role: 'colaborador',
    company_id: 'company-x',
    profile_id: 'profile-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  findPaginatedMock.mockResolvedValue({
    data: [
      makeUser({ id: 'user-1', nome: 'Ana', cpf: '11111111111' }),
      makeUser({ id: 'user-2', nome: 'Bruno', cpf: '22222222222' }),
    ],
    total: 2,
    lastPage: 1,
  });
  verifyStepUpMock.mockResolvedValue({ stepUpToken: 'token-123' });
  UserIdentityType.SYSTEM_USER as string;
});

describe('useUsers', () => {
  it('não quebra quando um usuário tem cpf null (regressão do crash .includes)', async () => {
    findPaginatedMock.mockResolvedValue({
      data: [
        makeUser({ id: 'user-1', nome: 'Ana', cpf: '11111111111' }),
        makeUser({ id: 'user-2', nome: 'Anonimizado', cpf: null }),
      ],
      total: 2,
      lastPage: 1,
    });

    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setSearchTerm('ana');
    });

    await waitFor(() => {
      expect(result.current.filteredUsers.map((u) => u.id)).toEqual(['user-1']);
    });
  });

  it('não quebra quando nome é undefined e busca vazia retorna todos', async () => {
    findPaginatedMock.mockResolvedValue({
      data: [
        makeUser({ id: 'user-1', nome: undefined as unknown as string, cpf: '11111111111' }),
        makeUser({ id: 'user-2', nome: 'Bruno', cpf: null }),
      ],
      total: 2,
      lastPage: 1,
    });

    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.filteredUsers).toHaveLength(2);
  });

  it('hard delete envia companyId resolvido do tenant/sessão', async () => {
    hardDeleteMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.requestHardDelete('user-1');
    });
    act(() => {
      result.current.setStepUpValue('123456');
    });
    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(hardDeleteMock).toHaveBeenCalledWith('user-1', 'token-123', 'company-x');
    expect(result.current.users.map((u) => u.id)).toEqual(['user-2']);
    expect(toast.success).toHaveBeenCalled();
  });

  it('gdpr erasure remove o usuário da lista local', async () => {
    gdprErasureMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.requestGdprErase('user-2');
    });
    act(() => {
      result.current.setStepUpValue('123456');
    });
    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(gdprErasureMock).toHaveBeenCalledWith('user-2', 'token-123', 'company-x');
    expect(result.current.users.map((u) => u.id)).toEqual(['user-1']);
    expect(toast.success).toHaveBeenCalled();
  });

  it('limpa o tenant anterior e envia o novo escopo ao trocar de empresa', async () => {
    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.users.map((user) => user.id)).toEqual(['user-1', 'user-2']);

    act(() => {
      mockTenantListener?.({ companyId: 'company-y', companyName: 'Empresa Y' });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.users).toHaveLength(2);
    });

    expect(findPaginatedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ companyId: 'company-y' }),
    );
  });

  it('ignora uma resposta antiga quando a empresa muda durante a requisição', async () => {
    let resolveCompanyX!: (response: unknown) => void;
    findPaginatedMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompanyX = resolve;
        }),
    );
    findPaginatedMock.mockResolvedValueOnce({
      data: [makeUser({ id: 'user-y', company_id: 'company-y' })],
      total: 1,
      lastPage: 1,
    });

    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(findPaginatedMock).toHaveBeenCalledTimes(1));

    act(() => {
      mockTenantListener?.({ companyId: 'company-y', companyName: 'Empresa Y' });
    });

    await waitFor(() => expect(result.current.users.map((user) => user.id)).toEqual(['user-y']));

    await act(async () => {
      resolveCompanyX({
        data: [makeUser({ id: 'user-x', company_id: 'company-x' })],
        total: 1,
        lastPage: 1,
      });
      await Promise.resolve();
    });

    expect(result.current.users.map((user) => user.id)).toEqual(['user-y']);
  });
});
