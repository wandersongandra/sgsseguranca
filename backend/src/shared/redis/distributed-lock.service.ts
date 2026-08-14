import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from './redis.service';

export type DistributedLockHandle = {
  key: string;
  token: string;
};

@Injectable()
export class DistributedLockService {
  constructor(private readonly redisService: RedisService) {}

  async tryAcquire(
    name: string,
    ttlMs: number,
  ): Promise<DistributedLockHandle | null> {
    const key = this.buildKey(name);
    const token = randomUUID();
    const safeTtlMs = this.normalizeTtlMs(ttlMs);
    const result = (await this.redisService
      .getClient()
      .set(key, token, 'PX', safeTtlMs, 'NX')) as string | null;

    if (result !== 'OK') {
      return null;
    }

    return { key, token };
  }

  async release(
    handle: DistributedLockHandle | null | undefined,
  ): Promise<boolean> {
    if (!handle) {
      return false;
    }

    const released = (await this.redisService.getClient().eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
      1,
      handle.key,
      handle.token,
    )) as number;

    return released === 1;
  }

  /**
   * Renova o lease somente quando o token ainda pertence ao solicitante.
   *
   * A comparação e o PEXPIRE precisam ocorrer no mesmo script Lua: um GET
   * seguido de PEXPIRE permitiria renovar por engano um lock adquirido por
   * outra réplica após o lease original expirar.
   */
  async extend(
    handle: DistributedLockHandle | null | undefined,
    ttlMs: number,
  ): Promise<boolean> {
    if (!handle) {
      return false;
    }

    const safeTtlMs = this.normalizeTtlMs(ttlMs);
    const extended = (await this.redisService.getClient().eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('PEXPIRE', KEYS[1], ARGV[2])
        end
        return 0
      `,
      1,
      handle.key,
      handle.token,
      String(safeTtlMs),
    )) as number;

    return extended === 1;
  }

  private buildKey(name: string): string {
    return name.startsWith('lock:') ? name : `lock:${name}`;
  }

  private normalizeTtlMs(ttlMs: number): number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return 30_000;
    }

    return Math.floor(ttlMs);
  }
}
