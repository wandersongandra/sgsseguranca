import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * TenantInterceptor — mantido como stub para compatibilidade de módulo.
 *
 * O contexto de tenant (AsyncLocalStorage) é estabelecido pelo TenantMiddleware.
 * A injeção de app.current_company_id/app.is_super_admin no PostgreSQL é feita
 * pelo TenantDbContextService (pool hook), que cobre TODAS as conexões TypeORM.
 *
 * Este interceptor não é uma barreira de segurança e não deve ser tratado como
 * enforcement. Ele não precisa fazer chamadas ao banco — fazê-lo criaria race
 * conditions e envenenamento do pool de conexões. O enforcement da camada de
 * aplicação é feito pelo TenantGuard e pelos serviços tenant-scoped; o
 * PostgreSQL permanece como segunda barreira via RLS.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle();
  }
}
