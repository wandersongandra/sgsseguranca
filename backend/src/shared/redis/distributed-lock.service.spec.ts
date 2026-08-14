import { DistributedLockService } from './distributed-lock.service';
import { RedisService } from './redis.service';

describe('DistributedLockService', () => {
  function createService() {
    const client = {
      set: jest.fn(),
      eval: jest.fn(),
    };
    const redisService = {
      getClient: jest.fn(() => client),
    } as unknown as RedisService;

    return {
      service: new DistributedLockService(redisService),
      client,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('adquire lock distribuido com prefixo e ttl normalizado', async () => {
    const { service, client } = createService();
    client.set.mockResolvedValue('OK');

    const handle = await service.tryAcquire('mail:scheduled-alerts', 12_345.8);

    expect(handle).toEqual(
      expect.objectContaining({
        key: 'lock:mail:scheduled-alerts',
      }),
    );
    expect(typeof handle?.token).toBe('string');
    expect(client.set).toHaveBeenCalledWith(
      'lock:mail:scheduled-alerts',
      expect.any(String),
      'PX',
      12345,
      'NX',
    );
  });

  it('retorna null quando o lock ja esta adquirido', async () => {
    const { service, client } = createService();
    client.set.mockResolvedValue(null);

    await expect(
      service.tryAcquire('mail:scheduled-alerts', 10_000),
    ).resolves.toBeNull();
  });

  it('libera apenas o lock do proprio token', async () => {
    const { service, client } = createService();
    client.eval.mockResolvedValue(1);

    await expect(
      service.release({
        key: 'lock:mail:scheduled-alerts',
        token: 'token-1',
      }),
    ).resolves.toBe(true);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      'lock:mail:scheduled-alerts',
      'token-1',
    );
  });

  it('renova somente o lease que ainda pertence ao proprio token', async () => {
    const { service, client } = createService();
    client.eval.mockResolvedValue(1);

    await expect(
      service.extend(
        {
          key: 'lock:nonconformity:workflow:nc-1',
          token: 'token-1',
        },
        600_000,
      ),
    ).resolves.toBe(true);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('PEXPIRE', KEYS[1], ARGV[2])"),
      1,
      'lock:nonconformity:workflow:nc-1',
      'token-1',
      '600000',
    );
  });

  it('não reporta renovação quando o token não é mais dono do lock', async () => {
    const { service, client } = createService();
    client.eval.mockResolvedValue(0);

    await expect(
      service.extend(
        {
          key: 'lock:nonconformity:workflow:nc-1',
          token: 'token-expirado',
        },
        600_000,
      ),
    ).resolves.toBe(false);
  });
});
