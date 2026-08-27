import type { Request } from 'express';
import {
  createTrustedProxyPolicy,
  getRequestIp,
  resolveClientIp,
  TrustedProxyConfigurationError,
} from './request-ip.util';

describe('getRequestIp', () => {
  it('ignora XFF forjado por um peer que não é proxy confiável', () => {
    const request = {
      headers: {
        'x-forwarded-for': '203.0.113.10',
        'cf-connecting-ip': '198.51.100.20',
      },
      socket: {
        remoteAddress: '198.51.100.20',
      },
    } as unknown as Request;

    expect(getRequestIp(request)).toBe('198.51.100.20');
  });

  it('usa socket.remoteAddress como fallback', () => {
    const request = {
      socket: {
        remoteAddress: '172.16.0.5',
      },
    } as unknown as Request;

    expect(getRequestIp(request)).toBe('172.16.0.5');
  });

  it('resolve o cliente pelo XFF somente quando o peer está em CIDR confiável', () => {
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    });

    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '10.10.0.5' },
          headers: { 'x-forwarded-for': '203.0.113.20' },
        },
        policy,
      ),
    ).toBe('203.0.113.20');
  });

  it('usa o primeiro endereço não confiável da cadeia, não o primeiro XFF', () => {
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    });

    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '10.10.0.5' },
          headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.20' },
        },
        policy,
      ),
    ).toBe('203.0.113.20');
  });

  it('faz fallback seguro ao peer quando o XFF é inválido ou grande demais', () => {
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    });
    const request = {
      socket: { remoteAddress: '10.10.0.5' },
      headers: { 'x-forwarded-for': 'garbage, 203.0.113.20' },
    };

    expect(resolveClientIp(request, policy)).toBe('10.10.0.5');
    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '10.10.0.5' },
          headers: { 'x-forwarded-for': '1'.repeat(4097) },
        },
        policy,
      ),
    ).toBe('10.10.0.5');
  });

  it('normaliza IPv4-mapped IPv6 para o mesmo bucket IPv4', () => {
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    });

    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '::ffff:10.10.0.5' },
          headers: { 'x-forwarded-for': '::ffff:203.0.113.20' },
        },
        policy,
      ),
    ).toBe('203.0.113.20');
  });

  it('respeita as fronteiras de CIDR IPv4 e IPv6', () => {
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_CIDRS: '10.10.0.5/32,2001:db8::1/128',
    });

    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '10.10.0.5' },
          headers: { 'x-forwarded-for': '203.0.113.20' },
        },
        policy,
      ),
    ).toBe('203.0.113.20');
    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '10.10.0.6' },
          headers: { 'x-forwarded-for': '203.0.113.20' },
        },
        policy,
      ),
    ).toBe('10.10.0.6');
    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '[2001:db8::1]' },
          headers: { 'x-forwarded-for': '2001:db8::20' },
        },
        policy,
      ),
    ).toBe('2001:db8::20');
    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '2001:db8::2' },
          headers: { 'x-forwarded-for': '2001:db8::20' },
        },
        policy,
      ),
    ).toBe('2001:db8::2');
  });

  it('exige CIDR explícito e rejeita trust-all ou ausência em produção', () => {
    expect(() =>
      createTrustedProxyPolicy(
        { NODE_ENV: 'production' },
        { requireInProduction: true },
      ),
    ).toThrow(TrustedProxyConfigurationError);
    expect(() =>
      createTrustedProxyPolicy({ TRUSTED_PROXY_CIDRS: 'true' }),
    ).toThrow(TrustedProxyConfigurationError);
    expect(() =>
      createTrustedProxyPolicy({ TRUSTED_PROXY_CIDRS: '0.0.0.0/0' }),
    ).toThrow(TrustedProxyConfigurationError);
    expect(() =>
      createTrustedProxyPolicy({ TRUSTED_PROXY_CIDRS: '::/0' }),
    ).toThrow(TrustedProxyConfigurationError);
    for (const value of [
      'CHANGE_ME_PROXY_CIDR',
      'not-a-cidr',
      '0.0.0.0/0',
      '::/0',
      'true',
    ]) {
      expect(() =>
        createTrustedProxyPolicy(
          { NODE_ENV: 'production', TRUSTED_PROXY_CIDRS: value },
          { requireInProduction: true },
        ),
      ).toThrow(TrustedProxyConfigurationError);
    }
  });

  it('não usa X-Real-IP, Forwarded ou CF-Connecting-IP como autoridade', () => {
    const policy = createTrustedProxyPolicy({
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    });

    expect(
      resolveClientIp(
        {
          socket: { remoteAddress: '198.51.100.30' },
          headers: {
            'x-real-ip': '203.0.113.10',
            forwarded: 'for=203.0.113.20',
            'cf-connecting-ip': '192.0.2.10',
          },
        },
        policy,
      ),
    ).toBe('198.51.100.30');
  });
});
