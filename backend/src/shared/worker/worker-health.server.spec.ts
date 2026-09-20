import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { startWorkerHealthServer } from './worker-health.server';

describe('worker health HTTP contract', () => {
  const logger = { info: jest.fn(), error: jest.fn() };
  const check = jest.fn<Promise<boolean>, []>();
  let health: ReturnType<typeof startWorkerHealthServer>;
  let base: string;

  beforeEach(async () => {
    check.mockReset().mockResolvedValue(false);
    health = startWorkerHealthServer(logger, check, 0);
    await health.listening;
    base = `http://127.0.0.1:${(health.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => health.close());

  function request(
    path: string,
  ): Promise<{ status: number | undefined; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${base}${path}`, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode, body }),
          );
        })
        .on('error', reject);
    });
  }

  it('keeps liveness independent of unavailable dependencies', async () => {
    await expect(request('/health/live')).resolves.toMatchObject({
      status: 200,
    });
    expect(check).not.toHaveBeenCalled();
  });

  it.each(['/health', '/health/ready', '/health/public'])(
    'fails closed during startup or dependency failure: %s',
    async (path) => {
      await expect(request(path)).resolves.toMatchObject({ status: 503 });
    },
  );

  it('reports ready only when the dependency probe succeeds', async () => {
    check.mockResolvedValue(true);
    await expect(request('/health/ready')).resolves.toMatchObject({
      status: 200,
    });
  });

  it('does not expose dependency errors in public health', async () => {
    check.mockRejectedValue(new Error('synthetic-private-diagnostic'));
    const response = await request('/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).not.toContain('synthetic-private-diagnostic');
  });

  it('rejects unknown routes', async () => {
    await expect(request('/unknown')).resolves.toMatchObject({ status: 404 });
    expect(check).not.toHaveBeenCalled();
  });

  it('rejects startup if another process owns the health port', async () => {
    const conflicting = startWorkerHealthServer(
      logger,
      check,
      Number(new URL(base).port),
    );
    await expect(conflicting.listening).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  it.each([true, false])(
    'Docker healthcheck checks this process readiness: %s',
    async (ready) => {
      check.mockResolvedValue(ready);
      const child = spawn(
        process.execPath,
        [resolve('scripts/healthcheck-worker.js')],
        {
          env: { PORT: new URL(base).port, SystemRoot: process.env.SystemRoot },
          stdio: 'ignore',
        },
      );
      const exitCode = await new Promise<number | null>(
        (resolveExit, reject) => {
          child.once('exit', resolveExit);
          child.once('error', reject);
        },
      );
      expect(exitCode).toBe(ready ? 0 : 1);
      expect(check).toHaveBeenCalled();
    },
  );
});
