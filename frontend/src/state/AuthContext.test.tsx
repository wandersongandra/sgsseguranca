import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AuthProvider,
  DEFAULT_IDLE_LOGOUT_MINUTES,
  MAX_IDLE_LOGOUT_MINUTES,
  resolveIdleLogoutMs,
  useAuth,
  useAuthState,
} from "@/context/AuthContext";
import { authService } from "@/services/authService";
import { authRefreshHint } from "@/lib/authRefreshHint";
import { sessionStore } from "@/lib/sessionStore";
import { tokenStore } from "@/lib/tokenStore";
import { forcePasswordChangeStore } from "@/lib/forcePasswordChangeStore";
import type { User } from "@/services/usersService";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

jest.mock("@/services/authService", () => ({
  authService: {
    getCsrfToken: jest.fn(),
    refreshAccessToken: jest.fn(),
    getCurrentSession: jest.fn(),
    logout: jest.fn(),
    login: jest.fn(),
  },
}));

const user: User = {
  id: "user-1",
  nome: "Operador SGS",
  email: "operador@sgs.local",
  cpf: "12345678900",
  role: "operador",
  company_id: "company-1",
  profile_id: "profile-1",
  profile: {
    id: "profile-1",
    nome: "Operador",
    permissoes: [],
  },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function clearCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; path=/`;
}

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/`;
}

function AuthProbe() {
  const { loading, user: currentUser } = useAuthState();

  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{currentUser?.id ?? "none"}</span>
    </div>
  );
}

describe("AuthProvider bootstrap", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pushMock.mockClear();
    authRefreshHint.clear();
    sessionStore.clear();
    tokenStore.clear();
    forcePasswordChangeStore.clear();
    clearCookie("refresh_csrf");

    (authService.getCsrfToken as jest.Mock).mockResolvedValue(undefined);
    (authService.refreshAccessToken as jest.Mock).mockResolvedValue({
      accessToken: "access-token-1",
    });
    (authService.getCurrentSession as jest.Mock).mockResolvedValue({
      user,
      roles: ["operador"],
      permissions: ["can_view_dashboard"],
      isAdminGeral: false,
    });
  });

  afterEach(() => {
    clearCookie("refresh_csrf");
  });

  it("renova sessão com refresh_csrf mesmo sem hint local", async () => {
    setCookie("refresh_csrf", "refresh-csrf-token");

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    expect(authRefreshHint.get()).toBe(false);
    expect(authService.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(authService.getCurrentSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("user")).toHaveTextContent("user-1");
    expect(tokenStore.get()).toBe("access-token-1");
  });

  it("não tenta refresh quando não existe refresh_csrf", async () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );

    expect(authService.refreshAccessToken).not.toHaveBeenCalled();
    expect(authService.getCurrentSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });
});

function LoginProbe() {
  const { login, user } = useAuth();

  return (
    <div>
      <span data-testid="user">{user?.id ?? "none"}</span>
      <button onClick={() => login("12345678900", "senha-temporaria")}>
        entrar
      </button>
    </div>
  );
}

function LogoutProbe() {
  const { logout } = useAuth();

  return (
    <button onClick={() => void logout('/login?expired=1')}>
      sair
    </button>
  );
}

describe("AuthProvider redirecionamento de logout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pushMock.mockClear();
    (authService.logout as jest.Mock).mockResolvedValue(undefined);
  });

  it("preserva a indicação de sessão expirada no redirecionamento", async () => {
    render(
      <AuthProvider>
        <LogoutProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "sair" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/login?expired=1");
    });
  });
});

describe("AuthProvider login com must_change_password", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pushMock.mockClear();
    authRefreshHint.clear();
    sessionStore.clear();
    tokenStore.clear();
    forcePasswordChangeStore.clear();
    clearCookie("refresh_csrf");

    (authService.getCsrfToken as jest.Mock).mockResolvedValue(undefined);
  });

  it("não abre sessão normal e redireciona para troca de senha obrigatória", async () => {
    (authService.login as jest.Mock).mockResolvedValue({
      accessToken: "token-temporario",
      user: { id: "user-novo", nome: "Novo Usuário", must_change_password: true },
    });

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "entrar" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/trocar-senha-inicial");
    });

    // Nenhuma sessão "normal" é aberta: sem roles/permissions, user do
    // AuthState continua vazio — só o tokenStore guarda o token limitado
    // (usado exclusivamente para chamar /auth/change-password).
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    expect(tokenStore.get()).toBe("token-temporario");
    expect(forcePasswordChangeStore.get()).toEqual({ nome: "Novo Usuário" });
  });

  it("abre sessão normal quando must_change_password é falso", async () => {
    (authService.login as jest.Mock).mockResolvedValue({
      accessToken: "token-normal",
      user,
      roles: ["operador"],
      permissions: ["can_view_dashboard"],
      isAdminGeral: false,
    });

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "entrar" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/dashboard");
    });

    expect(screen.getByTestId("user")).toHaveTextContent("user-1");
    expect(forcePasswordChangeStore.get()).toBeNull();
  });
});

describe("resolveIdleLogoutMs", () => {
  const originalValue = process.env.NEXT_PUBLIC_IDLE_LOGOUT_MINUTES;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.NEXT_PUBLIC_IDLE_LOGOUT_MINUTES;
      return;
    }

    process.env.NEXT_PUBLIC_IDLE_LOGOUT_MINUTES = originalValue;
  });

  it("mantém a sessão aberta por sete dias quando não há configuração explícita", () => {
    delete process.env.NEXT_PUBLIC_IDLE_LOGOUT_MINUTES;

    expect(resolveIdleLogoutMs()).toBe(
      DEFAULT_IDLE_LOGOUT_MINUTES * 60 * 1000,
    );
  });

  it("limita uma configuração de inatividade longa a trinta dias", () => {
    process.env.NEXT_PUBLIC_IDLE_LOGOUT_MINUTES = "999999";

    expect(resolveIdleLogoutMs()).toBe(
      MAX_IDLE_LOGOUT_MINUTES * 60 * 1000,
    );
  });
});
