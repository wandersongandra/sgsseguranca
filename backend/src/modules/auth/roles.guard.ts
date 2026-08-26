import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { Role } from './enums/roles.enum';
import { RbacService } from '../rbac/rbac.service';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { normalizeRoleName } from './role-normalization.util';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private reflector: Reflector,
    private readonly rbacService: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const requiredRoles = this.reflector.getAllAndOverride<string[] | Role[]>(
      ROLES_KEY,
      targets,
    );
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      targets,
    );

    // Default-deny para rotas sem contrato de autorização explícito.
    // Se a rota usa @Authorize/@Permissions, o PermissionsGuard decide a
    // autorização fina e o RolesGuard não deve bloquear antes dele.
    if (!requiredRoles || requiredRoles.length === 0) {
      if (requiredPermissions?.length) {
        return true;
      }

      this.logger.warn({
        event: 'unauthorized_access_no_roles_required',
        path: context.getHandler().name,
        class: context.getClass().name,
        timestamp: new Date().toISOString(),
      });
      throw new ForbiddenException('Acesso negado: função não especificada');
    }

    const request = context.switchToHttp().getRequest<{
      user?: {
        userId?: string;
        id?: string;
        profile?: { nome: string };
        roles?: string[];
        permissions?: string[];
      };
    }>();
    const userId = request.user?.userId || request.user?.id;
    const rawUserRole = request.user?.profile?.nome;
    const userRole = this.normalizeRole(rawUserRole);
    const normalizedRequiredRoles = (requiredRoles || [])
      .map((role) => this.normalizeRole(role))
      .filter((role): role is Role => !!role);

    if (!userId) {
      this.logger.warn({
        event: 'unauthorized_access_no_user',
        path: context.getHandler().name,
        class: context.getClass().name,
        timestamp: new Date().toISOString(),
      });
      throw new ForbiddenException('Usuário não autenticado');
    }

    // Se o token não carregou profile.nome (ou veio vazio), fazemos fallback via RBAC.
    // Isso evita bloquear ADMIN_GERAL quando a fonte de verdade (RBAC) está correta.
    if (!userRole) {
      try {
        const access = await this.rbacService.getUserAccess(userId, {
          profileName: rawUserRole,
        });

        // Propaga para baixo (controllers) para logging/observabilidade consistente.
        request.user = {
          ...(request.user || {}),
          id: userId,
          userId,
          roles: access.roles,
          permissions: access.permissions,
        };

        const resolvedRoles = (access.roles || [])
          .map((roleName) => this.normalizeRole(roleName))
          .filter((role): role is Role => !!role);

        if (
          resolvedRoles.some((role) =>
            this.hasRequiredRole(role, normalizedRequiredRoles),
          )
        ) {
          return true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({
          event: 'unauthorized_access_invalid_role',
          userId,
          attemptedRole: rawUserRole,
          requiredRoles,
          path: context.getHandler().name,
          class: context.getClass().name,
          error: message,
          timestamp: new Date().toISOString(),
        });
      }

      this.logger.warn({
        event: 'unauthorized_access_invalid_role',
        userId,
        attemptedRole: rawUserRole,
        requiredRoles,
        path: context.getHandler().name,
        class: context.getClass().name,
        timestamp: new Date().toISOString(),
      });
      throw new ForbiddenException('Função de usuário inválida');
    }

    // Verificar se o usuário tem uma das roles requeridas
    if (!this.hasRequiredRole(userRole, normalizedRequiredRoles)) {
      // Buscar acesso completo via RBAC para logging detalhado
      try {
        const access = await this.rbacService.getUserAccess(userId, {
          profileName: rawUserRole,
        });
        this.logger.warn({
          event: 'unauthorized_access_insufficient_role',
          userId,
          userRole,
          userRoles: access.roles,
          userPermissions: access.permissions,
          requiredRoles,
          path: context.getHandler().name,
          class: context.getClass().name,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Se falhar ao buscar acesso, log sem detalhes adicionais
        this.logger.warn({
          event: 'unauthorized_access_insufficient_role',
          userId,
          userRole,
          requiredRoles,
          path: context.getHandler().name,
          class: context.getClass().name,
          error: message,
          timestamp: new Date().toISOString(),
        });
      }

      throw new ForbiddenException('Função insuficiente para esta operação');
    }

    return true;
  }

  private normalizeRole(role?: string | Role): Role | null {
    return normalizeRoleName(role);
  }

  private hasRequiredRole(userRole: Role, requiredRoles: Role[]): boolean {
    // Não existe hierarquia implícita: ADMIN_GERAL só satisfaz um contrato
    // que o declara explicitamente. O mesmo vale para SUPER_ADMIN; operações
    // de plataforma precisam declarar esse papel no endpoint.
    return requiredRoles.includes(userRole);
  }
}
