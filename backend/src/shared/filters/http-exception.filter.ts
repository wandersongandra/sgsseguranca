import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { captureException } from '../monitoring/sentry';
import {
  maskSensitiveText,
  sanitizeLogObject,
  sanitizeLogUrl,
} from '../logging/log-sanitizer.util';

interface ExceptionResponse {
  message?: string | string[];
  error?: string;
  details?: unknown;
  errors?: unknown;
}

interface AuthenticatedRequest extends Request {
  requestId?: string;
  requestStartAt?: number;
  user?: {
    id?: string;
    userId?: string;
    company_id?: string;
    profile?: { nome?: string };
    role?: string;
    [key: string]: unknown;
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const isProduction = process.env.NODE_ENV === 'production';
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<AuthenticatedRequest>();
    const sanitizedPath = sanitizeLogUrl(request.url);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Erro interno do servidor';
    let code = 'INTERNAL_SERVER_ERROR';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse() as ExceptionResponse;

      if (typeof exceptionResponse === 'object') {
        message = this.sanitizeMessage(
          exceptionResponse.message || exception.message,
        );
        code = exceptionResponse.error || exception.name;
        details = sanitizeLogObject(
          exceptionResponse.details ?? exceptionResponse.errors,
        );
      } else {
        message = this.sanitizeMessage(exceptionResponse);
      }

      // Sanitização em produção: para 5xx, não expor mensagens internas ao client.
      const preserveOperationalDetails =
        request.url === '/health' || code === 'DOCUMENT_STORAGE_UNAVAILABLE';

      if (
        isProduction &&
        status >= HttpStatus.INTERNAL_SERVER_ERROR &&
        !preserveOperationalDetails
      ) {
        message = 'Erro interno do servidor';
        details = undefined;
      }
    } else if (exception instanceof QueryFailedError) {
      const dbError = exception as Error & { code?: string };

      if (dbError.code === '23505') {
        status = HttpStatus.CONFLICT;
        code = 'DUPLICATE_ENTRY';
      } else if (dbError.code === '23503' || dbError.code === '23514') {
        status = HttpStatus.UNPROCESSABLE_ENTITY;
        code =
          dbError.code === '23503'
            ? 'FOREIGN_KEY_VIOLATION'
            : 'CHECK_CONSTRAINT_VIOLATION';
      } else {
        status = HttpStatus.BAD_REQUEST;
        code = 'DATABASE_ERROR';
      }

      // Em produção: mensagem genérica para não revelar estrutura do banco.
      // Em desenvolvimento: mensagem específica para facilitar depuração.
      if (isProduction) {
        message = 'Erro ao processar dados. Tente novamente.';
      } else {
        if (dbError.code === '23505') {
          message = 'Registro duplicado';
        } else if (dbError.code === '23503') {
          message = 'Violação de chave estrangeira';
        } else if (dbError.code === '23514') {
          message = 'Violação de regra de negócio';
        } else {
          message = 'Erro ao processar consulta no banco de dados';
        }
      }
    } else if (
      exception instanceof Error &&
      'status' in exception &&
      typeof (exception as { status?: unknown }).status === 'number'
    ) {
      // Erros nativos de middleware Express (body-parser entity.too.large, multer, etc.)
      // que carregam `status`/`type` mas não são HttpException.
      const expErr = exception as unknown as { status: number; type?: string };
      status =
        expErr.status >= 400 && expErr.status < 600
          ? expErr.status
          : HttpStatus.BAD_REQUEST;
      code = expErr.type || exception.name;
      message = isProduction
        ? status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Erro interno do servidor'
          : 'Requisição inválida'
        : this.sanitizeMessage(exception.message);
    } else if (exception instanceof Error) {
      // Em produção, evitar vazar mensagens internas (stack traces, libs, infra, SQL, etc.).
      message = isProduction
        ? 'Erro interno do servidor'
        : this.sanitizeMessage(exception.message);
      code = exception.name;
    }

    const publicErrorCode = this.toPublicErrorCode(status, code);
    const errorResponse = {
      success: false,
      statusCode: status,
      message,
      errorCode: publicErrorCode,
      error: {
        code,
        message,
        details,
        timestamp: new Date().toISOString(),
        path: sanitizedPath,
        requestId: request.requestId,
      },
    };

    // Rotas de browser/crawler sem rota registrada — ignorar completamente
    const SILENT_PATHS = [
      '/favicon.ico',
      '/robots.txt',
      '/apple-touch-icon.png',
    ];
    if (
      SILENT_PATHS.includes(sanitizedPath) &&
      status === HttpStatus.NOT_FOUND
    ) {
      response.status(status).json(errorResponse);
      return;
    }

    // Log proporcional à gravidade: 4xx → warn, 5xx → error
    const user = request.user;
    const logMeta = {
      type: 'HTTP_EXCEPTION',
      statusCode: status,
      ...errorResponse.error,
      method: request.method,
      responseTimeMs:
        typeof request.requestStartAt === 'number'
          ? Date.now() - request.requestStartAt
          : undefined,
      context: {
        userId: user?.id || user?.userId,
        companyId: user?.company_id,
        role:
          user?.role ||
          (typeof user?.profile === 'object' ? user.profile?.nome : undefined),
      },
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({
        ...logMeta,
        diagnostic:
          exception instanceof Error ? { stack: exception.stack } : undefined,
      });
    } else if (exception instanceof QueryFailedError) {
      const dbError = exception as Error & { code?: string };
      this.logger.warn({
        ...logMeta,
        diagnostic: { pgCode: dbError.code, pgMessage: exception.message },
      });
    } else {
      this.logger.warn(logMeta);
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      captureException(exception, {
        tags: {
          requestId: request.requestId || 'unknown',
          method: request.method,
          path: sanitizedPath,
        },
        extra: {
          userId: user?.id || user?.userId,
          code,
        },
      });
    }

    response.status(status).json(errorResponse);
  }

  private sanitizeMessage(message: string | string[]): string | string[] {
    if (Array.isArray(message)) {
      return message.map((item) => maskSensitiveText(String(item)));
    }

    return maskSensitiveText(String(message));
  }

  private toPublicErrorCode(status: number, fallback: string): string {
    if (status === 400) return 'BAD_REQUEST';
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 409) return 'CONFLICT';
    if (status === 422) return 'UNPROCESSABLE_ENTITY';
    if (status === 429) return 'TOO_MANY_REQUESTS';
    if (status >= 500) {
      return 'INTERNAL_SERVER_ERROR';
    }
    return String(fallback || 'ERROR').toUpperCase();
  }
}
