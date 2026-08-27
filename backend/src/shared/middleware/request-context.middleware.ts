import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { getRequestIp } from '../utils/request-ip.util';

export const requestContextStorage = new AsyncLocalStorage<
  Map<string, unknown>
>();

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId =
      (req.headers['x-request-id'] as string) || crypto.randomUUID();
    const store = new Map<string, unknown>();

    store.set('requestId', requestId);
    // User data will be populated after auth middleware runs, so we might need to rely on the interceptor or another middleware
    // However, AsyncLocalStorage context persists.
    // If AuthGuard runs *after* this middleware, req['user'] will be undefined here initially.
    // But since this is a middleware, it runs before Guards.
    // We can update the store later or just access req.user directly in the service if needed,
    // but the goal is to have it available in the context.
    // Ideally, this middleware should run *after* passport initialization if possible, or we update the store later.
    // For now, let's set what we have. If req['user'] is set by a previous middleware (e.g. passport), it works.
    // If not, we might need to update the context in a Guard or Interceptor.

    // Actually, for the Audit decorator to work, we need these values available when the method is called.
    // Guards run before Interceptors and Route Handlers. Middleware runs before Guards.
    // So req.user is usually NOT available in Middleware unless we do something custom.
    // However, let's implement as requested. We can also set 'ip' and 'userAgent' here.

    store.set('ip', getRequestIp(req));
    store.set('userAgent', req.headers['user-agent']);

    // Mantém uma única origem de requestId para todo o pipeline.
    (req as Request & { requestId?: string }).requestId = requestId;

    // Adicionar requestId ao response header
    res.setHeader('X-Request-ID', requestId);

    requestContextStorage.run(store, () => {
      next();
    });
  }
}

export class RequestContext {
  static get<T = unknown>(key: string): T | undefined {
    const store = requestContextStorage.getStore();
    return store?.get(key) as T | undefined;
  }

  static set(key: string, value: unknown): void {
    const store = requestContextStorage.getStore();
    if (!store) {
      return;
    }

    store.set(key, value);
  }

  static getOrSet<T>(key: string, factory: () => T): T {
    const existing = this.get<T>(key);
    if (existing !== undefined) {
      return existing;
    }

    const nextValue = factory();
    this.set(key, nextValue);
    return nextValue;
  }

  static getRequestId(): string | undefined {
    return this.get('requestId');
  }

  static getUserId(): string | undefined {
    return this.get('userId');
  }

  static getCompanyId(): string | undefined {
    return this.get('companyId');
  }

  static getSiteId(): string | undefined {
    return this.get('siteId');
  }

  static getSentryTraceId(): string | undefined {
    return this.get('sentryTraceId');
  }

  static getTraceId(): string | undefined {
    return this.get('traceId') ?? this.getSentryTraceId();
  }
}
