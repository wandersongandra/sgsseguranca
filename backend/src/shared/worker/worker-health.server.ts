import * as http from 'node:http';
import type { createStructuredWinstonLogger } from '../logging/structured-winston';

type HealthLogger = Pick<
  ReturnType<typeof createStructuredWinstonLogger>,
  'info' | 'error'
>;

export function getWorkerHealthPort(): number {
  const port = Number(process.env.PORT || '8080');
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8080;
}

export function startWorkerHealthServer(
  logger: HealthLogger,
  checkReadiness: () => Promise<boolean>,
  port = getWorkerHealthPort(),
) {
  const handleRequest = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    const isLiveness = request.url === '/health/live';
    const isReadiness = ['/health', '/health/ready', '/health/public'].includes(
      request.url || '',
    );
    let ready = isLiveness;
    if (isReadiness) {
      try {
        ready = await checkReadiness();
      } catch {
        ready = false;
      }
    }
    response.writeHead(isLiveness || isReadiness ? (ready ? 200 : 503) : 404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      JSON.stringify({
        status:
          isLiveness || isReadiness
            ? ready
              ? 'ok'
              : 'unavailable'
            : 'not_found',
        runtime: 'worker',
        timestamp: new Date().toISOString(),
      }),
    );
  };
  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.on('error', (error) => {
    logger.error({
      event: 'worker_health_server_error',
      errorName: error.name,
    });
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      logger.info({
        event: 'worker_health_server_listening',
        port,
        healthPath: '/health/ready',
      });
      resolve();
    });
  });
  return {
    port,
    server,
    listening,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
