import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import { ForbiddenSpikeInterceptor } from './forbidden-spike.interceptor';
import {
  SecurityAuditService,
  SecurityEventType,
  SecuritySeverity,
} from './security-audit.service';

const mockRedis = {
  get: jest.fn(),
  eval: jest.fn(),
  multi: jest.fn(),
};

const mockMulti = {
  del: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

mockRedis.multi.mockReturnValue(mockMulti);

const mockSecurityAudit = {
  emit: jest.fn(),
};

function makeContext(ip = '1.2.3.4', userId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        ip,
        path: '/some/endpoint',
        method: 'GET',
        headers: {},
        socket: { remoteAddress: ip },
        user: userId ? { userId } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeHandler(obs: Observable<unknown>) {
  return { handle: () => obs };
}

describe('ForbiddenSpikeInterceptor', () => {
  let interceptor: ForbiddenSpikeInterceptor;

  beforeEach(() => {
    jest.clearAllMocks();
    interceptor = new ForbiddenSpikeInterceptor(
      mockRedis as never,
      mockSecurityAudit as unknown as SecurityAuditService,
    );
  });

  it('should pass through when IP is not blocked and no error', (done) => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue(1);

    interceptor
      .intercept(makeContext(), makeHandler(of({ ok: true })))
      .subscribe({
        next: (val) => {
          expect(val).toEqual({ ok: true });
          done();
        },
      });
  });

  it('should throw 429 immediately when IP is in spike block list', (done) => {
    mockRedis.get.mockResolvedValue('1');

    interceptor
      .intercept(makeContext(), makeHandler(of({ ok: true })))
      .subscribe({
        error: (err: unknown) => {
          expect(err).toBeInstanceOf(HttpException);
          expect((err as HttpException).getStatus()).toBe(
            HttpStatus.TOO_MANY_REQUESTS,
          );
          done();
        },
      });
  });

  it('should track ForbiddenException from handler', (done) => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue(3); // below threshold

    interceptor
      .intercept(
        makeContext(),
        makeHandler(throwError(() => new ForbiddenException())),
      )
      .subscribe({
        error: (err: unknown) => {
          expect(err).toBeInstanceOf(ForbiddenException);
          expect(mockRedis.eval).toHaveBeenCalledTimes(1);
          done();
        },
      });
  });

  it('should track UnauthorizedException from handler', (done) => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue(2);

    interceptor
      .intercept(
        makeContext(),
        makeHandler(throwError(() => new UnauthorizedException())),
      )
      .subscribe({
        error: (err: unknown) => {
          expect(err).toBeInstanceOf(UnauthorizedException);
          expect(mockRedis.eval).toHaveBeenCalledTimes(1);
          done();
        },
      });
  });

  it('should block IP and emit FORBIDDEN_SPIKE when threshold is reached', (done) => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue(15); // at threshold (default 15)

    interceptor
      .intercept(
        makeContext('5.6.7.8', 'user-uuid'),
        makeHandler(throwError(() => new ForbiddenException())),
      )
      .subscribe({
        error: () => {
          // trackAndMaybeBlock is fire-and-forget — wait for all microtasks to settle
          setImmediate(() => {
            expect(mockRedis.multi).toHaveBeenCalledTimes(1);
            expect(mockMulti.set).toHaveBeenCalledWith(
              'security:forbidden_spike:block:5.6.7.8',
              '1',
              'EX',
              expect.any(Number),
            );
            expect(mockSecurityAudit.emit).toHaveBeenCalledWith(
              expect.objectContaining({
                event: SecurityEventType.FORBIDDEN_SPIKE,
                severity: SecuritySeverity.CRITICAL,
                ip: '5.6.7.8',
              }),
            );
            done();
          });
        },
      });
  });

  it('should NOT emit spike for non-403/401 errors', (done) => {
    mockRedis.get.mockResolvedValue(null);

    interceptor
      .intercept(
        makeContext(),
        makeHandler(throwError(() => new HttpException('not found', 404))),
      )
      .subscribe({
        error: () => {
          expect(mockRedis.eval).not.toHaveBeenCalled();
          expect(mockSecurityAudit.emit).not.toHaveBeenCalled();
          done();
        },
      });
  });

  it('should fail-open (allow) when Redis is unavailable for block check', (done) => {
    mockRedis.get.mockRejectedValue(new Error('Redis connection refused'));

    interceptor
      .intercept(makeContext(), makeHandler(of({ ok: true })))
      .subscribe({
        next: (val) => {
          expect(val).toEqual({ ok: true });
          done();
        },
      });
  });

  it('ignora X-Forwarded-For bruto e usa apenas o peer de transporte', (done) => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue(1);

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          path: '/test',
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
          socket: { remoteAddress: '10.0.0.1' },
          user: undefined,
        }),
      }),
    } as unknown as ExecutionContext;

    interceptor
      .intercept(ctx, makeHandler(throwError(() => new ForbiddenException())))
      .subscribe({
        error: () => {
          setImmediate(() => {
            expect(mockRedis.eval).toHaveBeenCalledWith(
              expect.any(String),
              1,
              'security:forbidden_spike:counter:10.0.0.1',
              expect.any(String),
            );
            done();
          });
        },
      });
  });

  it('não cria controle para endereço inválido', (done) => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          ip: 'not-an-ip',
          path: '/test',
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.1' },
          socket: { remoteAddress: 'also-invalid' },
        }),
      }),
    } as unknown as ExecutionContext;

    interceptor
      .intercept(ctx, makeHandler(throwError(() => new ForbiddenException())))
      .subscribe({
        error: () => {
          expect(mockRedis.get).not.toHaveBeenCalled();
          expect(mockRedis.eval).not.toHaveBeenCalled();
          done();
        },
      });
  });
});
