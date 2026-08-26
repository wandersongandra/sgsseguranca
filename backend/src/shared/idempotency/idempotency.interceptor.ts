import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Observable, from, of, throwError } from 'rxjs';
import { switchMap, mergeMap, catchError, map } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import {
  DurableIdempotencyPersistenceException,
  IdempotencyService,
} from './idempotency.service';
import { TenantService } from '../tenant/tenant.service';

type IdempotencyRequest = Request<
  Record<string, string>,
  unknown,
  unknown,
  Record<string, unknown>
> & {
  user?: {
    userId?: string;
    id?: string;
  };
};

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const NON_REPLAYABLE_CONTENT_TYPES = [
  'multipart/form-data',
  'application/octet-stream',
];

function readHeader(
  request: IdempotencyRequest,
  headerName: string,
): string | undefined {
  const headers: unknown = request.headers;
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const headerEntry = Object.entries(headers as Record<string, unknown>).find(
    ([name]) => name.toLowerCase() === headerName.toLowerCase(),
  );
  const value: unknown = headerEntry?.[1];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'undefined') {
    return '__undefined__';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      sha256: createHash('sha256').update(value).digest('hex'),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new BadRequestException(
        'O conteúdo desta requisição não pode usar idempotência.',
      );
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key], seen);
    }
    seen.delete(value);
    return result;
  }

  throw new BadRequestException(
    'O conteúdo desta requisição não pode usar idempotência.',
  );
}

function buildRequestHash(request: IdempotencyRequest): string {
  const contentType = readHeader(request, 'content-type');
  const canonicalRequest = canonicalize({
    method: request.method.toUpperCase(),
    path: request.path,
    contentType: contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '',
    query: request.query ?? {},
    params: request.params ?? {},
    body: request.body,
  });

  return createHash('sha256')
    .update(JSON.stringify(canonicalRequest))
    .digest('hex');
}

/**
 * Interceptor global de idempotência.
 *
 * Ativado automaticamente quando o cliente envia o header X-Idempotency-Key
 * em requisições POST, PUT ou PATCH.
 *
 * Comportamento:
 * - Primeira request com a chave → processa normalmente e armazena resposta limitada
 * - Request repetida com mesma chave → retorna resposta armazenada sem reprocessar
 * - Request concorrente com mesma chave → retorna 409 Conflict
 *
 * Uso pelo cliente:
 *   POST /reports/generate
 *   X-Idempotency-Key: uuid-gerado-pelo-cliente
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private readonly IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH']);

  constructor(private readonly idempotencyService: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<IdempotencyRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const idempotencyKeyValue = readHeader(request, 'x-idempotency-key');

    // Só aplica em métodos não-seguros com a header presente
    const method = request.method.toUpperCase();
    if (!idempotencyKeyValue || !this.IDEMPOTENT_METHODS.has(method)) {
      return next.handle();
    }

    const contentType = readHeader(request, 'content-type')
      ?.trim()
      .toLowerCase();
    if (
      contentType &&
      NON_REPLAYABLE_CONTENT_TYPES.some((blocked) =>
        contentType.startsWith(blocked),
      )
    ) {
      return next.handle();
    }

    const tenantId = TenantService.currentTenantId();
    const authenticatedUserId = request.user?.userId ?? request.user?.id;
    const scopeId = authenticatedUserId
      ? tenantId
        ? `tenant:${tenantId}:user:${authenticatedUserId}`
        : `user:${authenticatedUserId}`
      : undefined;
    if (!scopeId) {
      // Nunca armazenar respostas públicas (ex.: login) em um namespace
      // "anonymous" compartilhado entre usuários.
      return next.handle();
    }

    const idempotencyKey = idempotencyKeyValue.trim();
    if (
      !idempotencyKey ||
      idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
    ) {
      throw new BadRequestException(
        'X-Idempotency-Key inválida. Use até 128 caracteres alfanuméricos, ponto, hífen, sublinhado ou dois-pontos.',
      );
    }

    const { path } = request;
    const requestHash = buildRequestHash(request);

    // Usar from() para converter a Promise em Observable e encadear
    return from(
      this.idempotencyService.getRecord(scopeId, method, path, idempotencyKey),
    ).pipe(
      switchMap((existing) => {
        if (existing && existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Esta chave de idempotência já foi usada com uma requisição diferente.',
          );
        }

        // Resposta já processada → retornar cache sem reprocessar
        if (existing?.status === 'completed') {
          if (existing.responseStored === false) {
            throw new ConflictException(
              'A operação desta chave já foi concluída, mas a resposta não pode ser repetida. Consulte o recurso antes de tentar novamente.',
            );
          }
          this.logger.debug(
            `Idempotent response from cache: ${method} ${path}`,
          );
          response.setHeader('X-Idempotent-Replayed', 'true');
          response.status(existing.statusCode ?? 200);
          return from(Promise.resolve(existing.body));
        }

        // Outra request ainda processando → 409 Conflict
        if (existing?.status === 'processing') {
          throw new ConflictException(
            'Uma requisição com esta chave de idempotência já está em processamento. Aguarde e tente novamente.',
          );
        }

        // Primeira vez → marcar como processing via SET NX
        return from(
          this.idempotencyService.markProcessing(
            scopeId,
            method,
            path,
            idempotencyKey,
            requestHash,
          ),
        ).pipe(
          switchMap((acquisition) => {
            if (acquisition === 'quota_exceeded') {
              throw new ServiceUnavailableException(
                'Limite temporário de chaves de idempotência atingido. Tente novamente mais tarde.',
              );
            }

            if (acquisition !== 'acquired') {
              // Outra instância ganhou a corrida
              throw new ConflictException(
                'Uma requisição com esta chave de idempotência já está em processamento.',
              );
            }

            return next.handle().pipe(
              catchError((error: unknown) =>
                from(
                  this.idempotencyService.deleteRecord(
                    scopeId,
                    method,
                    path,
                    idempotencyKey,
                  ),
                ).pipe(
                  catchError((cleanupError: unknown) => {
                    this.logger.error(
                      `Falha ao liberar chave após erro da operação: ${method} ${path}`,
                      cleanupError instanceof Error
                        ? cleanupError.stack
                        : undefined,
                    );
                    return of(undefined);
                  }),
                  mergeMap(() => throwError(() => error)),
                ),
              ),
              mergeMap((body: unknown) =>
                from(
                  this.idempotencyService.saveResponse(
                    scopeId,
                    method,
                    path,
                    idempotencyKey,
                    requestHash,
                    response.statusCode,
                    body,
                  ),
                ).pipe(
                  map((): unknown => body),
                  catchError((persistenceError: unknown) => {
                    if (
                      persistenceError instanceof
                      DurableIdempotencyPersistenceException
                    ) {
                      return throwError(() => persistenceError);
                    }
                    this.logger.error(
                      `Operação concluída, mas resposta idempotente não foi persistida: ${method} ${path}`,
                      persistenceError instanceof Error
                        ? persistenceError.stack
                        : undefined,
                    );
                    response.setHeader(
                      'X-Idempotency-Status',
                      'persistence-degraded',
                    );
                    return of(body);
                  }),
                ),
              ),
            );
          }),
        );
      }),
    );
  }
}
