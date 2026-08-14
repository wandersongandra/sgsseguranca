import {
  buildIntegrityFlags,
  hashDeviceId,
  maskIpAddress,
  parseOptionalDate,
  roundCoordinate,
} from './evidence-integrity.util';

describe('evidence-integrity.util', () => {
  describe('maskIpAddress', () => {
    it('reduz IPv4 para /24 zerando o último octeto', () => {
      expect(maskIpAddress('192.168.10.37')).toBe('192.168.10.0');
      expect(maskIpAddress('8.8.8.8')).toBe('8.8.8.0');
    });

    it('trunca IPv6 ao /48', () => {
      expect(maskIpAddress('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(
        '2001:0db8:85a3::',
      );
    });

    it('devolve null para valor ausente ou vazio', () => {
      expect(maskIpAddress(null)).toBeNull();
      expect(maskIpAddress(undefined)).toBeNull();
      expect(maskIpAddress('')).toBeNull();
    });

    it('nunca devolve o endereço original intacto quando há algo a mascarar', () => {
      const ip = '10.0.0.99';
      expect(maskIpAddress(ip)).not.toBe(ip);
    });
  });

  describe('hashDeviceId', () => {
    const originalKey = process.env.FIELD_ENCRYPTION_KEY;

    afterEach(() => {
      if (originalKey === undefined) {
        delete process.env.FIELD_ENCRYPTION_KEY;
      } else {
        process.env.FIELD_ENCRYPTION_KEY = originalKey;
      }
    });

    it('é determinístico para a mesma chave e entrada', () => {
      process.env.FIELD_ENCRYPTION_KEY = 'chave-fixa-de-teste';
      expect(hashDeviceId('dispositivo-A')).toBe(hashDeviceId('dispositivo-A'));
    });

    it('produz hashes distintos para dispositivos distintos', () => {
      process.env.FIELD_ENCRYPTION_KEY = 'chave-fixa-de-teste';
      expect(hashDeviceId('dispositivo-A')).not.toBe(
        hashDeviceId('dispositivo-B'),
      );
    });

    it('muda o hash quando a chave muda', () => {
      process.env.FIELD_ENCRYPTION_KEY = 'chave-1';
      const comChave1 = hashDeviceId('dispositivo-A');
      process.env.FIELD_ENCRYPTION_KEY = 'chave-2';
      expect(hashDeviceId('dispositivo-A')).not.toBe(comChave1);
    });

    it('não vaza o identificador original no resultado', () => {
      process.env.FIELD_ENCRYPTION_KEY = 'chave-fixa-de-teste';
      const hash = hashDeviceId('iphone-do-joao');
      expect(hash).not.toContain('iphone');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('ignora espaços em volta e devolve null para entrada vazia', () => {
      process.env.FIELD_ENCRYPTION_KEY = 'chave-fixa-de-teste';
      expect(hashDeviceId('  dispositivo-A  ')).toBe(
        hashDeviceId('dispositivo-A'),
      );
      expect(hashDeviceId('   ')).toBeNull();
      expect(hashDeviceId(null)).toBeNull();
      expect(hashDeviceId(undefined)).toBeNull();
    });
  });

  describe('roundCoordinate', () => {
    it('arredonda para 2 casas decimais (~1 km)', () => {
      expect(roundCoordinate(-23.5605412)).toBe(-23.56);
      expect(roundCoordinate(-46.6433212)).toBe(-46.64);
    });

    it('preserva o zero em vez de tratá-lo como ausente', () => {
      expect(roundCoordinate(0)).toBe(0);
    });

    it('devolve null para não-número ou valor não finito', () => {
      expect(roundCoordinate(null)).toBeNull();
      expect(roundCoordinate(undefined)).toBeNull();
      expect(roundCoordinate(Number.NaN)).toBeNull();
      expect(roundCoordinate(Number.POSITIVE_INFINITY)).toBeNull();
    });
  });

  describe('parseOptionalDate', () => {
    it('converte ISO 8601 em Date', () => {
      const parsed = parseOptionalDate('2026-08-08T12:30:00.000Z');
      expect(parsed).toBeInstanceOf(Date);
      expect(parsed?.toISOString()).toBe('2026-08-08T12:30:00.000Z');
    });

    it('devolve null para vazio, ausente ou data inválida', () => {
      expect(parseOptionalDate('')).toBeNull();
      expect(parseOptionalDate('   ')).toBeNull();
      expect(parseOptionalDate(null)).toBeNull();
      expect(parseOptionalDate(undefined)).toBeNull();
      expect(parseOptionalDate('nao-e-data')).toBeNull();
    });
  });

  describe('buildIntegrityFlags', () => {
    it('marca gps apenas quando latitude e longitude são números', () => {
      expect(
        buildIntegrityFlags({ latitude: -23.56, longitude: -46.64 }).gps,
      ).toBe(true);
      expect(buildIntegrityFlags({ latitude: -23.56 }).gps).toBe(false);
      expect(buildIntegrityFlags({}).gps).toBe(false);
    });

    it('trata coordenada 0 como presente', () => {
      expect(buildIntegrityFlags({ latitude: 0, longitude: 0 }).gps).toBe(true);
    });

    it('reflete a presença de cada metadado', () => {
      const flags = buildIntegrityFlags({
        latitude: -23.56,
        longitude: -46.64,
        accuracy_m: 12.5,
        device_id: 'dispositivo-A',
        ipAddress: '10.0.0.1',
        exif_datetime: '2026-08-08T12:00:00Z',
      });
      expect(flags).toMatchObject({
        gps: true,
        accuracy: true,
        device: true,
        ip: true,
        exif: true,
      });
    });

    it('devolve tudo falso quando nada foi informado', () => {
      expect(buildIntegrityFlags({})).toEqual({
        gps: false,
        accuracy: false,
        device: false,
        ip: false,
        exif: false,
      });
    });

    it('omite client_reencoded quando o chamador não se pronuncia', () => {
      expect(buildIntegrityFlags({})).not.toHaveProperty('client_reencoded');
    });

    it('registra client_reencoded quando informado, inclusive false', () => {
      expect(
        buildIntegrityFlags({ clientReencoded: true }).client_reencoded,
      ).toBe(true);
      expect(
        buildIntegrityFlags({ clientReencoded: false }).client_reencoded,
      ).toBe(false);
    });
  });
});
