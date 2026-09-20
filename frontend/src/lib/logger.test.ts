import { logger } from './logger';

describe('logger', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('remove tokens e PII de erros e payloads aninhados antes do console', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const error = new Error(
      'Falha para cpf 123.456.789-00 e email pessoa@example.com',
    );
    Object.assign(error, {
      config: {
        url: 'https://storage.example/file.pdf?X-Amz-Signature=signature-secret&token=url-token',
        headers: {
          Authorization: 'Bearer access-secret',
          'x-csrf-token': 'csrf-secret',
          'content-type': 'application/json',
        },
        data: { password: 'senha-super-secreta' },
      },
      response: {
        data: {
          cpf: '12345678900',
          email: 'pessoa@example.com',
          nested: { refreshToken: 'refresh-secret' },
        },
      },
    });

    logger.error('Falha de autenticação', error, {
      authorization: 'Bearer payload-secret',
      telefone: '65999999999',
    });

    const output = consoleError.mock.calls
      .flat()
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join(' ');

    expect(output).not.toContain('access-secret');
    expect(output).not.toContain('csrf-secret');
    expect(output).not.toContain('senha-super-secreta');
    expect(output).not.toContain('12345678900');
    expect(output).not.toContain('pessoa@example.com');
    expect(output).not.toContain('refresh-secret');
    expect(output).not.toContain('signature-secret');
    expect(output).not.toContain('url-token');
    expect(output).toContain('[REDACTED]');
  });
});
