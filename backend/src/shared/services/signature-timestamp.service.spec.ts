import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { SignatureTimestampService } from './signature-timestamp.service';

describe('SignatureTimestampService', () => {
  const testSecret = 's'.repeat(64);
  let jwtSecret = 'j'.repeat(64);
  const service = new SignatureTimestampService({
    get: jest.fn((key: string) => {
      if (key === 'SIGNATURE_TIMESTAMP_SECRET') return testSecret;
      if (key === 'JWT_SECRET') return jwtSecret;
      return undefined;
    }),
  } as unknown as ConfigService);

  afterEach(() => {
    jwtSecret = 'j'.repeat(64);
  });

  it('verifica tokens com timestamp ISO contendo milissegundos', () => {
    const stamp = service.issueFromHash(
      'a'.repeat(64),
      '2026-08-25T00:00:00.000Z',
    );

    expect(service.verify(stamp.signature_hash, stamp.timestamp_token)).toBe(
      true,
    );
  });

  it('rejeita hash adulterado mantendo o token original', () => {
    const stamp = service.issueFromHash(
      'b'.repeat(64),
      '2026-08-25T00:00:00.000Z',
    );

    expect(service.verify('c'.repeat(64), stamp.timestamp_token)).toBe(false);
  });

  it('assina exatamente o hash e timestamp canônicos no payload HMAC', () => {
    const hash = 'd'.repeat(64);
    const issuedAt = '2026-08-25T00:00:00.123Z';
    const stamp = service.issueFromHash(hash, issuedAt);
    const expectedMac = createHmac('sha256', testSecret)
      .update(`${hash}.${issuedAt}`)
      .digest('hex');

    expect(stamp.timestamp_token).toBe(`${issuedAt}.${expectedMac}`);
  });

  it('rejeita timestamp adulterado mesmo com o MAC original', () => {
    const stamp = service.issueFromHash(
      'e'.repeat(64),
      '2026-08-25T00:00:00.000Z',
    );
    const tamperedToken = stamp.timestamp_token.replace('00.000Z', '00.001Z');

    expect(service.verify(stamp.signature_hash, tamperedToken)).toBe(false);
  });

  it('rejeita MAC vazio, truncado, não hexadecimal ou com caracteres extras', () => {
    const hash = 'f'.repeat(64);
    const timestamp = '2026-08-25T00:00:00.000Z';
    const invalidTokens = [
      '',
      `${timestamp}.`,
      `${timestamp}.${'a'.repeat(63)}`,
      `${timestamp}.${'g'.repeat(64)}`,
      `${timestamp}.${'a'.repeat(65)}`,
    ];

    for (const token of invalidTokens) {
      expect(service.verify(hash, token)).toBe(false);
    }
  });

  it.each([
    '2026-08-25T00:00:00Z',
    '2026-08-24T21:00:00.000-03:00',
    '2026-02-30T00:00:00.000Z',
    '2026-08-25 00:00:00.000',
  ])('rejeita timestamp não canônico: %s', (issuedAt) => {
    expect(() => service.issueFromHash('1'.repeat(64), issuedAt)).toThrow(
      TypeError,
    );
  });

  it('aceita timestamp futuro canônico porque este serviço não declara expiração', () => {
    const stamp = service.issueFromHash(
      '2'.repeat(64),
      '9999-12-31T23:59:59.999Z',
    );

    expect(service.verify(stamp.signature_hash, stamp.timestamp_token)).toBe(
      true,
    );
  });

  it('rejeita hash não canônico e entradas de verificação não-string', () => {
    expect(() => service.issueFromHash('A'.repeat(64))).toThrow(TypeError);
    expect(service.verify('A'.repeat(64), 'token')).toBe(false);
    expect(service.verify('1'.repeat(64), null as never)).toBe(false);
  });

  it('falha fechado quando a chave configurada está ausente', () => {
    const withoutSecret = new SignatureTimestampService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);

    expect(() =>
      withoutSecret.issueFromHash('3'.repeat(64), '2026-08-25T00:00:00.000Z'),
    ).toThrow('Missing SIGNATURE_TIMESTAMP_SECRET');
    expect(
      withoutSecret.verify(
        '3'.repeat(64),
        '2026-08-25T00:00:00.000Z.' + 'a'.repeat(64),
      ),
    ).toBe(false);
  });

  it('não usa JWT_SECRET como fallback quando a chave dedicada está ausente', () => {
    const jwtOnly = new SignatureTimestampService({
      get: jest.fn((key: string) =>
        key === 'JWT_SECRET' ? 'j'.repeat(64) : undefined,
      ),
    } as unknown as ConfigService);

    expect(() =>
      jwtOnly.issueFromHash('4'.repeat(64), '2026-08-25T00:00:00.000Z'),
    ).toThrow('Missing SIGNATURE_TIMESTAMP_SECRET');
  });

  it('rejeita chave dedicada curta sem tentar usar JWT_SECRET', () => {
    const shortDedicatedKey = new SignatureTimestampService({
      get: jest.fn((key: string) => {
        if (key === 'SIGNATURE_TIMESTAMP_SECRET') return 's'.repeat(31);
        if (key === 'JWT_SECRET') return 'j'.repeat(64);
        return undefined;
      }),
    } as unknown as ConfigService);

    expect(() =>
      shortDedicatedKey.issueFromHash(
        '5'.repeat(64),
        '2026-08-25T00:00:00.000Z',
      ),
    ).toThrow('Signature timestamp secret is too short');
  });

  it('mantém a verificação quando JWT_SECRET é rotacionado independentemente', () => {
    const hash = '6'.repeat(64);
    const stamp = service.issueFromHash(hash, '2026-08-25T00:00:00.000Z');

    jwtSecret = 'k'.repeat(64);

    expect(service.verify(hash, stamp.timestamp_token)).toBe(true);
  });

  it('mantém a verificação quando JWT_REFRESH_SECRET é rotacionado independentemente', () => {
    const refreshSecret = { value: 'r'.repeat(64) };
    const refreshIndependentService = new SignatureTimestampService({
      get: jest.fn((key: string) => {
        if (key === 'SIGNATURE_TIMESTAMP_SECRET') return testSecret;
        if (key === 'JWT_REFRESH_SECRET') return refreshSecret.value;
        return undefined;
      }),
    } as unknown as ConfigService);
    const hash = '7'.repeat(64);
    const stamp = refreshIndependentService.issueFromHash(
      hash,
      '2026-08-25T00:00:00.000Z',
    );

    refreshSecret.value = 't'.repeat(64);

    expect(refreshIndependentService.verify(hash, stamp.timestamp_token)).toBe(
      true,
    );
  });
});
