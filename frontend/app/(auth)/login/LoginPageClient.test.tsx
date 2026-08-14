import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import LoginPageClient from './LoginPageClient';

const mockLogin = jest.fn();
const mockFinalizeLogin = jest.fn();
const mockActivateBootstrapMfa = jest.fn();

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: jest.fn(() => null),
  }),
}));

jest.mock('next/script', () => ({
  __esModule: true,
  default: function MockNextScript({ onLoad }: { onLoad?: () => void }) {
    React.useEffect(() => {
      onLoad?.();
    }, [onLoad]);
    return null;
  },
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    login: mockLogin,
    finalizeLogin: mockFinalizeLogin,
  }),
}));

jest.mock('@/services/authService', () => ({
  authService: {
    activateBootstrapMfa: (...args: unknown[]) => mockActivateBootstrapMfa(...args),
    verifyLoginMfa: jest.fn(),
  },
}));

jest.mock('qrcode.react', () => ({
  QRCodeCanvas: ({ title, value }: { title?: string; value: string }) => (
    <canvas data-testid="mfa-qr-code" title={title} data-value={value} />
  ),
}));

function fillCredentialsAndSubmit() {
  fireEvent.change(screen.getByLabelText('CPF'), {
    target: { value: '12345678900' },
  });
  fireEvent.change(screen.getByLabelText('Senha'), {
    target: { value: 'Senha@123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Acessar' }));
}

describe('LoginPageClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete (window as Window & { turnstile?: unknown }).turnstile;
  });

  it('entra no estágio challenge quando login retorna mfaRequired', async () => {
    mockLogin.mockResolvedValue({
      mfaRequired: true,
      challengeToken: 'challenge-token',
      expiresIn: 300,
      methods: ['totp'],
    });

    render(
      <LoginPageClient turnstileSiteKey="" supportHref="https://suporte.example" />,
    );

    fillCredentialsAndSubmit();

    expect(await screen.findByLabelText('Código MFA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar acesso' })).toBeInTheDocument();
    expect(mockLogin).toHaveBeenCalledWith('12345678900', 'Senha@123', undefined);
  });

  it('entra no estágio bootstrap quando login retorna mfaEnrollRequired', async () => {
    mockLogin.mockResolvedValue({
      mfaEnrollRequired: true,
      challengeToken: 'bootstrap-token',
      expiresIn: 600,
      otpAuthUrl: 'otpauth://totp/SGS?secret=ABCDEF',
      manualEntryKey: 'ABCDEF123',
      recoveryCodes: ['RCODE-1', 'RCODE-2'],
    });

    render(
      <LoginPageClient turnstileSiteKey="" supportHref="https://suporte.example" />,
    );

    fillCredentialsAndSubmit();

    expect(
      await screen.findByText(/primeiro acesso com mfa obrigatório/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Chave manual (backup)')).toHaveValue('ABCDEF123');
    expect(screen.getByTestId('mfa-qr-code')).toHaveAttribute(
      'data-value',
      'otpauth://totp/SGS?secret=ABCDEF',
    );
    expect(screen.getByText(/RCODE-1/)).toBeInTheDocument();
    expect(screen.getByText(/RCODE-2/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Abrir cadastro no app autenticador' })).toHaveAttribute(
      'href',
      'otpauth://totp/SGS?secret=ABCDEF',
    );
    expect(screen.getByRole('button', { name: 'Ativar MFA e entrar' })).toBeInTheDocument();
  });

  it('ativa MFA bootstrap e finaliza login ao enviar código MFA no estágio bootstrap', async () => {
    mockLogin.mockResolvedValue({
      mfaEnrollRequired: true,
      challengeToken: 'bootstrap-token',
      expiresIn: 600,
      otpAuthUrl: 'otpauth://totp/SGS?secret=ABCDEF',
      manualEntryKey: 'ABCDEF123',
      recoveryCodes: ['RCODE-1'],
    });

    mockActivateBootstrapMfa.mockResolvedValue({
      accessToken: 'token-final',
      user: { id: 'u1' },
      roles: [],
      permissions: [],
      isAdminGeral: false,
    });

    render(
      <LoginPageClient turnstileSiteKey="" supportHref="https://suporte.example" />,
    );

    fillCredentialsAndSubmit();
    const mfaInput = await screen.findByLabelText('Código MFA');
    fireEvent.change(mfaInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar MFA e entrar' }));

    await waitFor(() => {
      expect(mockActivateBootstrapMfa).toHaveBeenCalledWith('bootstrap-token', '123456');
    });
    expect(mockFinalizeLogin).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'token-final' }),
    );
  });

  it.each([
    [401, 'CPF, senha ou código MFA inválido.'],
    [429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'],
    [503, 'Serviço temporariamente indisponível. Tente novamente em instantes.'],
  ])('exibe mensagem adequada para erro HTTP %i', async (status, expectedMessage) => {
    mockLogin.mockRejectedValue({
      isAxiosError: true,
      response: { status },
    });

    render(
      <LoginPageClient turnstileSiteKey="" supportHref="https://suporte.example" />,
    );

    fillCredentialsAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(expectedMessage);
  });

  it('não vaza a mensagem do servidor quando login retorna 400 (anti-enumeração)', async () => {
    mockLogin.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: { message: 'CPF inválido' },
      },
    });

    render(
      <LoginPageClient turnstileSiteKey="" supportHref="https://suporte.example" />,
    );

    fillCredentialsAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dados inválidos. Verifique as informações e tente novamente.',
    );
    expect(screen.queryByText('CPF inválido')).not.toBeInTheDocument();
  });

  it('reseta turnstile e limpa token ao ocorrer erro no submit', async () => {
    const reset = jest.fn();
    const renderTurnstile = jest.fn<
      string,
      [unknown, { callback?: (token: string) => void }]
    >(() => 'widget-1');
    const remove = jest.fn();

    (window as Window & { turnstile?: unknown }).turnstile = {
      reset,
      render: renderTurnstile,
      remove,
    };

    mockLogin.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401 },
    });

    render(
      <LoginPageClient
        turnstileSiteKey="site-key"
        supportHref="https://suporte.example"
      />,
    );

    await waitFor(() => {
      expect(renderTurnstile).toHaveBeenCalled();
    });

    const turnstileOptions = renderTurnstile.mock.calls[0]![1] as {
      callback?: (token: string) => void;
    };
    await act(async () => {
      turnstileOptions.callback?.('turnstile-token');
    });

    fireEvent.change(screen.getByLabelText('CPF'), {
      target: { value: '12345678900' },
    });
    fireEvent.change(screen.getByLabelText('Senha'), {
      target: { value: 'Senha@123' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Acessar' }));

    await waitFor(() => {
      expect(reset).toHaveBeenCalledWith('widget-1');
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'CPF, senha ou código MFA inválido.',
    );
  });

  it('bloqueia submit sem token do Turnstile e mostra mensagem explícita', async () => {
    render(
      <LoginPageClient
        turnstileSiteKey="site-key"
        supportHref="https://suporte.example"
      />,
    );

    fireEvent.change(screen.getByLabelText('CPF'), {
      target: { value: '12345678900' },
    });
    fireEvent.change(screen.getByLabelText('Senha'), {
      target: { value: 'Senha@123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Acessar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Conclua a verificação de segurança antes de entrar.',
    );
    expect(mockLogin).not.toHaveBeenCalled();
  });
});
