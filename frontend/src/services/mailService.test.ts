import { extractMailDispatchErrorMessage } from './mailService';

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

describe('extractMailDispatchErrorMessage', () => {
  it('explica quando o circuit breaker do provedor esta aberto', async () => {
    await expect(
      extractMailDispatchErrorMessage({
        isAxiosError: true,
        response: {
          status: 503,
          data: {
            message:
              'A integracao de e-mail entrou em protecao apos falhas recentes.',
            code: 'MAIL_PROVIDER_CIRCUIT_OPEN',
            retryAfterSeconds: 30,
          },
        },
      }),
    ).resolves.toContain('30s');
  });

  it('mantem a mensagem original quando o erro nao e de e-mail estruturado', async () => {
    await expect(
      extractMailDispatchErrorMessage(new Error('Falha local inesperada')),
    ).resolves.toBe('Falha local inesperada');
  });
});
