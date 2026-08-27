import { Reflector } from '@nestjs/core';
import { AdvancedThrottlerGuard } from './advanced-throttler.guard';

describe('AdvancedThrottlerGuard', () => {
  it('usa o peer de transporte quando não há proxy confiável configurado', () => {
    const guard = new AdvancedThrottlerGuard(
      {} as never,
      {} as never,
      new Reflector(),
    ) as unknown as {
      getRequestIP: (request: Record<string, unknown>) => string;
    };

    const ip = guard.getRequestIP({
      headers: {
        'x-forwarded-for': '203.0.113.10',
        'cf-connecting-ip': '198.51.100.20',
      },
      socket: {
        remoteAddress: '172.16.0.5',
      },
    });

    expect(ip).toBe('172.16.0.5');
  });
});
