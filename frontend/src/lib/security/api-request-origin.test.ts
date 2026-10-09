import {
  assertTrustedApiTarget,
  UNTRUSTED_API_TARGET_CODE,
} from './api-request-origin';

const API = 'https://app.sgsseguranca.com.br/proxy';

function expectBlocked(url: string, baseURL?: string) {
  let caught: unknown;
  try {
    assertTrustedApiTarget(url, API, baseURL);
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: UNTRUSTED_API_TARGET_CODE });
}

describe('API request destination security', () => {
  it.each([
    '/users',
    'users?page=1',
    'https://app.sgsseguranca.com.br/proxy/users',
  ])('accepts a request inside the configured API surface: %s', (url) => {
    expect(() => assertTrustedApiTarget(url, API)).not.toThrow();
  });

  it.each([
    'https://external.example/collect',
    '//external.example/collect',
    'http://app.sgsseguranca.com.br/proxy/users',
    'javascript:alert(1)',
    'https://app.sgsseguranca.com.br/private',
    'https://app.sgsseguranca.com.br/proxy/../private',
    '/users\\data',
    '',
  ])('rejects a destination outside the configured API surface: %s', (url) => {
    expectBlocked(url);
  });

  it('rejects a per-request baseURL pointing outside the API origin', () => {
    expectBlocked('/users', 'https://external.example');
  });

  it('rejects a baseURL on the same host but outside the proxy path', () => {
    expectBlocked('/users', 'https://app.sgsseguranca.com.br/other');
  });
});
