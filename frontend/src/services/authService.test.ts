import api from '@/lib/api';
import { authService } from '@/services/authService';

const mockRefreshCsrfToken = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
  refreshCsrfToken: (...args: unknown[]) => mockRefreshCsrfToken(...args),
}));

describe('authService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('login', () => {
    it('retorna AuthLoginResponse com accessToken ao autenticar com credenciais válidas', async () => {
      const mockResponse = {
        data: {
          accessToken: 'token-abc123',
          user: { id: 'user-1', nome: 'João Silva', email: 'joao@example.com', cpf: '12345678900', role: 'admin', company_id: 'co-1', profile_id: 'p-1', created_at: '2026-01-01', updated_at: '2026-01-01' },
          roles: ['admin'],
          permissions: ['users:read'],
          isAdminGeral: true,
        },
      };
      (api.post as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.login('12345678900', 'senha123');

      expect(api.post).toHaveBeenCalledWith('/auth/login', {
        cpf: '12345678900',
        password: 'senha123',
        turnstileToken: undefined,
      });
      expect(result).toEqual(mockResponse.data);
      expect((result as { accessToken: string }).accessToken).toBe('token-abc123');
    });

    it('retorna AuthMfaChallengeResponse quando MFA é necessário', async () => {
      const mockResponse = {
        data: {
          mfaRequired: true as const,
          challengeToken: 'challenge-xyz',
          expiresIn: 300,
          methods: ['totp'],
        },
      };
      (api.post as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.login('12345678900', 'senha123');

      expect((result as { mfaRequired: boolean }).mfaRequired).toBe(true);
      expect((result as { challengeToken: string }).challengeToken).toBe('challenge-xyz');
    });

    it('retorna AuthMfaBootstrapResponse quando enroll de MFA é necessário', async () => {
      const mockResponse = {
        data: {
          mfaEnrollRequired: true as const,
          challengeToken: 'bootstrap-token',
          expiresIn: 600,
          otpAuthUrl: 'otpauth://totp/SGS?secret=ABC',
          manualEntryKey: 'ABCDEFGHIJ',
          recoveryCodes: ['code1', 'code2'],
        },
      };
      (api.post as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.login('12345678900', 'senha123', 'turnstile-token');

      expect(api.post).toHaveBeenCalledWith('/auth/login', {
        cpf: '12345678900',
        password: 'senha123',
        turnstileToken: 'turnstile-token',
      });
      expect((result as { mfaEnrollRequired: boolean }).mfaEnrollRequired).toBe(true);
      expect((result as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(2);
    });

    it('propaga erro 401 ao autenticar com credenciais inválidas', async () => {
      const authError = { response: { status: 401, data: { message: 'Credenciais inválidas' } } };
      (api.post as jest.Mock).mockRejectedValue(authError);

      await expect(authService.login('00000000000', 'errada')).rejects.toBe(authError);
    });

    it('propaga erro 403 quando usuário não tem permissão de acesso', async () => {
      const forbiddenError = { response: { status: 403, data: { message: 'Acesso negado' } } };
      (api.post as jest.Mock).mockRejectedValue(forbiddenError);

      await expect(authService.login('12345678900', 'senha123')).rejects.toBe(forbiddenError);
    });
  });

  describe('verifyLoginMfa', () => {
    it('retorna AuthLoginResponse ao verificar código MFA válido', async () => {
      const mockResponse = {
        data: {
          accessToken: 'mfa-token-xyz',
          user: { id: 'user-1', nome: 'João', email: 'joao@example.com', cpf: '12345678900', role: 'operator', company_id: 'co-1', profile_id: 'p-1', created_at: '2026-01-01', updated_at: '2026-01-01' },
          roles: ['operator'],
          permissions: [],
          isAdminGeral: false,
        },
      };
      (api.post as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.verifyLoginMfa('challenge-xyz', '123456');

      expect(api.post).toHaveBeenCalledWith('/auth/login/mfa/verify', {
        challengeToken: 'challenge-xyz',
        code: '123456',
      });
      expect(result.accessToken).toBe('mfa-token-xyz');
    });

    it('propaga erro ao verificar código MFA inválido', async () => {
      const mfaError = { response: { status: 400, data: { message: 'Código inválido' } } };
      (api.post as jest.Mock).mockRejectedValue(mfaError);

      await expect(authService.verifyLoginMfa('challenge-xyz', '000000')).rejects.toBe(mfaError);
    });
  });

  describe('activateBootstrapMfa', () => {
    it('ativa MFA bootstrap e retorna accessToken após confirmação do código', async () => {
      const mockResponse = {
        data: {
          accessToken: 'bootstrap-access-token',
          user: { id: 'user-2', nome: 'Maria', email: 'maria@example.com', cpf: '98765432100', role: 'safety', company_id: 'co-1', profile_id: 'p-2', created_at: '2026-01-01', updated_at: '2026-01-01' },
          roles: ['safety'],
          permissions: ['trainings:write'],
          isAdminGeral: false,
        },
      };
      (api.post as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.activateBootstrapMfa('bootstrap-token', '654321');

      expect(api.post).toHaveBeenCalledWith('/auth/login/mfa/bootstrap/activate', {
        challengeToken: 'bootstrap-token',
        code: '654321',
      });
      expect(result.accessToken).toBe('bootstrap-access-token');
    });
  });

  describe('verifyStepUp', () => {
    it('retorna stepUpToken após verificação step-up com código', async () => {
      const mockResponse = {
        data: { stepUpToken: 'step-up-token-abc', expiresIn: 120 },
      };
      (api.post as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.verifyStepUp({ reason: 'exclusão de usuário', code: '123456' });

      expect(api.post).toHaveBeenCalledWith('/auth/step-up/verify', {
        reason: 'exclusão de usuário',
        code: '123456',
      });
      expect(result.stepUpToken).toBe('step-up-token-abc');
      expect(result.expiresIn).toBe(120);
    });

    it('retorna stepUpToken após verificação step-up com senha', async () => {
      const mockResponse = {
        data: { stepUpToken: 'step-up-token-def', expiresIn: 120 },
      };
      (api.post as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.verifyStepUp({ reason: 'GDPR erasure', password: 'minhasenha' });

      expect(api.post).toHaveBeenCalledWith('/auth/step-up/verify', {
        reason: 'GDPR erasure',
        password: 'minhasenha',
      });
      expect(result.stepUpToken).toBe('step-up-token-def');
    });
  });

  describe('getCurrentSession', () => {
    it('retorna dados da sessão atual do usuário autenticado', async () => {
      const mockResponse = {
        data: {
          user: { id: 'user-1', nome: 'João', email: 'joao@example.com', cpf: '12345678900', role: 'admin', company_id: 'co-1', profile_id: 'p-1', created_at: '2026-01-01', updated_at: '2026-01-01' },
          roles: ['admin'],
          permissions: ['users:read', 'users:write'],
          isAdminGeral: true,
        },
      };
      (api.get as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.getCurrentSession();

      expect(api.get).toHaveBeenCalledWith('/auth/me');
      expect(result.roles).toContain('admin');
    });

    it('propaga erro 401 quando sessão está expirada', async () => {
      const sessionError = { response: { status: 401 } };
      (api.get as jest.Mock).mockRejectedValue(sessionError);

      await expect(authService.getCurrentSession()).rejects.toBe(sessionError);
    });
  });

  describe('refreshAccessToken', () => {
    it('retorna novo accessToken ao renovar sessão', async () => {
      const mockResponse = { data: { accessToken: 'novo-token-renovado' } };
      (api.post as jest.Mock).mockResolvedValue(mockResponse);

      const result = await authService.refreshAccessToken();

      expect(api.post).toHaveBeenCalledWith('/auth/refresh');
      expect(result.accessToken).toBe('novo-token-renovado');
    });

    it('compartilha uma única requisição entre refreshes concorrentes', async () => {
      let resolveRefresh!: (value: { data: { accessToken: string } }) => void;
      const refreshResponse = new Promise<{ data: { accessToken: string } }>(
        (resolve) => {
          resolveRefresh = resolve;
        },
      );
      (api.post as jest.Mock).mockReturnValue(refreshResponse);

      const first = authService.refreshAccessToken();
      const second = authService.refreshAccessToken();
      resolveRefresh({ data: { accessToken: 'token-compartilhado' } });

      await expect(Promise.all([first, second])).resolves.toEqual([
        { accessToken: 'token-compartilhado' },
        { accessToken: 'token-compartilhado' },
      ]);
      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('logout', () => {
    it('chama endpoint de logout sem retornar dados', async () => {
      (api.post as jest.Mock).mockResolvedValue({ data: null });

      await authService.logout();

      expect(api.post).toHaveBeenCalledWith('/auth/logout');
    });

    it('compartilha uma única requisição entre logouts concorrentes', async () => {
      let resolveLogout!: (value: { data: null }) => void;
      const logoutResponse = new Promise<{ data: null }>((resolve) => {
        resolveLogout = resolve;
      });
      (api.post as jest.Mock).mockReturnValue(logoutResponse);

      const first = authService.logout();
      const second = authService.logout();
      resolveLogout({ data: null });

      await expect(Promise.all([first, second])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCsrfToken', () => {
    it('delega para refreshCsrfToken do api module', async () => {
      await authService.getCsrfToken();

      expect(mockRefreshCsrfToken).toHaveBeenCalledTimes(1);
    });
  });
});
