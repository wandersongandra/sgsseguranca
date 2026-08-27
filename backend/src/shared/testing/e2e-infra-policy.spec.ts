import { isE2EInfraSkipAllowed } from './e2e-infra-policy';

describe('E2E infrastructure fail-closed policy', () => {
  it('does not allow an implicit local skip', () => {
    expect(isE2EInfraSkipAllowed({ NODE_ENV: 'test', CI: 'false' })).toBe(
      false,
    );
  });

  it('allows an explicit skip only for non-production local execution', () => {
    expect(
      isE2EInfraSkipAllowed({
        NODE_ENV: 'test',
        CI: 'false',
        E2E_ALLOW_INFRA_SKIP: 'true',
      }),
    ).toBe(true);
  });

  it('rejects the skip in CI even when explicitly requested', () => {
    expect(
      isE2EInfraSkipAllowed({
        NODE_ENV: 'test',
        CI: 'true',
        E2E_ALLOW_INFRA_SKIP: 'true',
      }),
    ).toBe(false);
  });

  it('rejects the skip in production', () => {
    expect(
      isE2EInfraSkipAllowed({
        NODE_ENV: 'production',
        E2E_ALLOW_INFRA_SKIP: 'true',
      }),
    ).toBe(false);
  });
});
