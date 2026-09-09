import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { extractApiErrorMessage, getFormErrorMessage } from './error-handler';

describe('extractApiErrorMessage', () => {
  it('normalizes validation messages from JSON payloads', async () => {
    const error = new AxiosError('bad request');
    error.response = {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: {} as InternalAxiosRequestConfig,
      data: {
        details: [
          {
            field: 'company_id',
            errors: ['Selecione uma empresa'],
          },
        ],
      },
    };

    await expect(extractApiErrorMessage(error, 'Fallback')).resolves.toBe(
      'company_id: Selecione uma empresa',
    );
  });

  it('extracts backend messages from blob responses', async () => {
    const error = new AxiosError('service unavailable');
    error.response = {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'content-type': 'application/json',
      },
      config: {} as InternalAxiosRequestConfig,
      data: {
        text: async () =>
          JSON.stringify({
            message: 'Storage governado indisponível no momento. Tente novamente em breve.',
          }),
      },
    };

    await expect(extractApiErrorMessage(error, 'Fallback')).resolves.toBe(
      'Storage governado indisponível no momento. Tente novamente em breve.',
    );
  });

  it('uses the original error message for non-axios failures', async () => {
    await expect(
      extractApiErrorMessage(new Error('Falha local de renderização'), 'Fallback'),
    ).resolves.toBe('Falha local de renderização');
  });
});

describe('getFormErrorMessage', () => {
  it('maps conflict responses to the form conflict message', () => {
    const error = new AxiosError('conflict');
    error.response = {
      status: 409,
      statusText: 'Conflict',
      headers: {},
      config: {} as InternalAxiosRequestConfig,
      data: {},
    };

    expect(
      getFormErrorMessage(error, {
        conflict: 'O registro foi alterado por outra pessoa.',
        fallback: 'Fallback',
      }),
    ).toBe('O registro foi alterado por outra pessoa.');
  });

  it('preserves Retry-After for rate-limited form responses', () => {
    const error = new AxiosError('rate limited');
    error.response = {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '60' },
      config: {} as InternalAxiosRequestConfig,
      data: {},
    };

    expect(getFormErrorMessage(error, {})).toBe('Muitas requisições. Tente novamente em 60s.');
  });
});
