import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { PermissionEntity } from './entities/permission.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';
import { UserRoleEntity } from './entities/user-role.entity';
import { RedisService } from '../../shared/redis/redis.service';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import {
  resolvePermissionsFromModuleKeys,
  normalizeUserModuleAccessKeys,
} from '../users/user-module-access.config';
import { normalizeRoleName } from '../auth/role-normalization.util';

const VISUALIZADOR_FALLBACK_PERMISSIONS = [
  'can_view_dashboard',
  'can_view_apr',
  'can_view_pt',
  'can_view_checklists',
  'can_view_nc',
  'can_view_signatures',
  'can_manage_signatures',
  'can_view_dds',
  'can_view_dids',
  'can_view_arrs',
  'can_view_trainings',
  'can_view_rdos',
  'can_view_expenses',
  'can_view_epi_assignments',
  'can_view_documents_registry',
  'can_view_sites',
  'can_view_notifications',
  'can_view_calendar',
] as const;

const TECNICO_FALLBACK_PERMISSIONS = [
  ...VISUALIZADOR_FALLBACK_PERMISSIONS,
  'can_view_risks',
  'can_edit_risks',
  'can_create_apr',
  'can_update_apr',
  'can_delete_apr',
  'can_generate_apr_pdf',
  // Permissões críticas de APR (fluxo de emissão): aprovar/reprovar/encerrar.
  // A migration 1709000000332 (split-apr-critical-permissions) concede estas ao
  // role TST no banco; o allowlist de escopo aqui precisa espelhar isso, senão
  // normalizeAccessBundle filtra a permissão concedida e o TST não consegue
  // aprovar APRs (embora aprove PTs). Mantém paridade com can_approve_pt.
  'can_approve_apr',
  'can_reject_apr',
  'can_finalize_apr',
  'can_view_pt',
  'can_manage_pt',
  'can_approve_pt',
  'can_manage_nc',
  'can_manage_checklists',
  'can_manage_catalogs',
  'can_view_audits',
  'can_view_medical_exams',
  'can_manage_medical_exams',
  'can_view_service_orders',
  'can_manage_service_orders',
  'can_view_mail',
  'can_manage_mail',
  'can_import_documents',
  'can_view_cats',
  'can_manage_cats',
  'can_view_activities',
  'can_manage_activities',
  'can_view_corrective_actions',
  'can_manage_corrective_actions',
  'can_manage_dds',
  'can_manage_dids',
  'can_manage_arrs',
  'can_manage_trainings',
  'can_manage_rdos',
  'can_manage_expenses',
  'can_manage_epi_assignments',
  'can_use_ai',
  'can_view_photographic_reports',
  'can_manage_photographic_reports',
  'can_generate_photographic_report_ai',
  'can_export_photographic_report_pdf',
  'can_export_photographic_report_word',
  'can_finalize_photographic_report',
  // TST precisa cadastrar e visualizar funcionários das obras que gerencia.
  'can_view_users',
  'can_manage_users',
] as const;

const SUPERVISOR_FALLBACK_PERMISSIONS = [
  ...TECNICO_FALLBACK_PERMISSIONS,
  // can_approve_apr/reject/finalize já herdados de TECNICO (paridade com PT).
  'can_manage_audits',
] as const;

const GERENTE_FALLBACK_PERMISSIONS = [
  ...SUPERVISOR_FALLBACK_PERMISSIONS,
  'can_view_users',
  'can_manage_users',
  'can_manage_notifications',
  'can_manage_push_subscriptions',
] as const;

const ADMIN_EMPRESA_FALLBACK_PERMISSIONS = [
  ...GERENTE_FALLBACK_PERMISSIONS,
  'can_close_expenses',
  'can_view_companies',
  'can_view_profiles',
  'can_manage_sites',
  'can_view_dossiers',
] as const;

const ADMIN_GERAL_ONLY_PERMISSIONS = [
  'can_manage_companies',
  'can_manage_profiles',
  'can_view_system_health',
  'can_manage_disaster_recovery',
] as const;

export const PROFILE_PERMISSION_FALLBACK: Record<string, string[]> = {
  // ADMIN_GERAL administra todos os módulos/obras do próprio tenant, mas não
  // recebe permissões de plataforma. O escopo global é SUPER_ADMIN explícito.
  'Administrador Geral': [...ADMIN_EMPRESA_FALLBACK_PERMISSIONS],
  SUPER_ADMIN: [
    ...ADMIN_EMPRESA_FALLBACK_PERMISSIONS,
    ...ADMIN_GERAL_ONLY_PERMISSIONS,
  ],
  'Administrador da Empresa': [...ADMIN_EMPRESA_FALLBACK_PERMISSIONS],
  ADMIN_EMPRESA: [...ADMIN_EMPRESA_FALLBACK_PERMISSIONS],
  Gerente: [...GERENTE_FALLBACK_PERMISSIONS],
  GERENTE: [...GERENTE_FALLBACK_PERMISSIONS],
  'Supervisor / Encarregado': [...SUPERVISOR_FALLBACK_PERMISSIONS],
  Supervisor: [...SUPERVISOR_FALLBACK_PERMISSIONS],
  SUPERVISOR: [...SUPERVISOR_FALLBACK_PERMISSIONS],
  'Técnico de Segurança do Trabalho (TST)': [...TECNICO_FALLBACK_PERMISSIONS],
  Técnico: [...TECNICO_FALLBACK_PERMISSIONS],
  Tecnico: [...TECNICO_FALLBACK_PERMISSIONS],
  'Técnico SST': [...TECNICO_FALLBACK_PERMISSIONS],
  'Tecnico SST': [...TECNICO_FALLBACK_PERMISSIONS],
  'Técnico de Segurança do Trabalho': [...TECNICO_FALLBACK_PERMISSIONS],
  'Tecnico de Seguranca do Trabalho': [...TECNICO_FALLBACK_PERMISSIONS],
  TST: [...TECNICO_FALLBACK_PERMISSIONS],
  TECNICO: [...TECNICO_FALLBACK_PERMISSIONS],
  'Operador / Colaborador': [...VISUALIZADOR_FALLBACK_PERMISSIONS],
  COLABORADOR: [...VISUALIZADOR_FALLBACK_PERMISSIONS],
  Trabalhador: [...VISUALIZADOR_FALLBACK_PERMISSIONS],
  TRABALHADOR: [...VISUALIZADOR_FALLBACK_PERMISSIONS],
  Visualizador: [...VISUALIZADOR_FALLBACK_PERMISSIONS],
  VISUALIZADOR: [...VISUALIZADOR_FALLBACK_PERMISSIONS],
};

type AccessBundle = {
  roles: string[];
  permissions: string[];
};

type RbacAccessAggregateRow = {
  role_names?: unknown;
  permission_names?: unknown;
  module_access_keys?: unknown;
};

type ProfileFallbackRow = {
  profile_name?: string | null;
  profile_permissions?: unknown;
};

type ModuleAccessRow = {
  module_access_keys?: unknown;
};

const DEFAULT_RBAC_ACCESS_CACHE_TTL_SECONDS = 120;

export type RoleScope =
  | 'SUPER_ADMIN'
  | 'ADMIN_EMPRESA'
  | 'GERENTE'
  | 'SUPERVISOR'
  | 'TECNICO'
  | 'VISUALIZADOR';

const ROLE_SCOPE_PRIORITY: RoleScope[] = [
  'SUPER_ADMIN',
  'ADMIN_EMPRESA',
  'GERENTE',
  'SUPERVISOR',
  'TECNICO',
  'VISUALIZADOR',
];

const ROLE_SCOPE_ALLOWED_PERMISSIONS: Record<
  Exclude<RoleScope, 'SUPER_ADMIN'>,
  readonly string[]
> = {
  ADMIN_EMPRESA: ADMIN_EMPRESA_FALLBACK_PERMISSIONS,
  GERENTE: GERENTE_FALLBACK_PERMISSIONS,
  SUPERVISOR: SUPERVISOR_FALLBACK_PERMISSIONS,
  TECNICO: TECNICO_FALLBACK_PERMISSIONS,
  VISUALIZADOR: VISUALIZADOR_FALLBACK_PERMISSIONS,
};

@Injectable()
export class RbacService {
  private readonly logger = new Logger(RbacService.name);
  private readonly localAccessCache = new Map<
    string,
    { value: AccessBundle; expiresAt: number }
  >();
  private readonly accessLookupsInFlight = new Map<
    string,
    Promise<AccessBundle>
  >();

  constructor(
    @InjectRepository(UserRoleEntity)
    private readonly userRolesRepository: Repository<UserRoleEntity>,
    @InjectRepository(RolePermissionEntity)
    private readonly rolePermissionsRepository: Repository<RolePermissionEntity>,
    @InjectRepository(PermissionEntity)
    private readonly permissionsRepository: Repository<PermissionEntity>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Resolve o bundle de acesso (roles + permissions) de um usuário.
   *
   * Hierarquia de resolução:
   * 1. Cache Redis (TTL configurável via RBAC_ACCESS_CACHE_TTL_SECONDS)
   * 2. RBAC normalizado: se o usuário possui roles em `user_roles`,
   *    usa as permissions de `role_permissions` + fallback estático por role name.
   *    Esta é a fonte canônica para usuários migrados para o RBAC.
   * 3. Fallback de perfil: se o usuário não possui nenhuma role RBAC,
   *    usa `profile.permissoes` (JSONB legado) + PROFILE_PERMISSION_FALLBACK.
   *    Mantido para compatibilidade com usuários pré-migração.
   *
   * Para forçar o uso exclusivo do RBAC, atribua ao menos uma role ao usuário.
   */
  async getUserAccess(
    userId: string,
    options?: { profileName?: string | null },
  ): Promise<AccessBundle> {
    const requestCached = this.getRequestScopedAccess(userId);
    if (requestCached) {
      this.logAccessResolution('request_cache_hit', userId);
      return requestCached;
    }

    const localCached = this.getLocalAccess(userId);
    if (localCached) {
      this.setRequestScopedAccess(userId, localCached);
      this.logAccessResolution('local_cache_hit', userId);
      return localCached;
    }

    const inFlight = this.accessLookupsInFlight.get(userId);
    if (inFlight) {
      return inFlight;
    }

    const lookupPromise = this.lookupUserAccess(userId, options)
      .then((access) => {
        this.setRequestScopedAccess(userId, access);
        return access;
      })
      .finally(() => {
        this.accessLookupsInFlight.delete(userId);
      });
    this.accessLookupsInFlight.set(userId, lookupPromise);
    return lookupPromise;
  }

  async getAllPermissionNames(): Promise<string[]> {
    const rows = await this.permissionsRepository.find({
      select: { name: true },
      order: { name: 'ASC' },
    });
    return rows.map((permission) => permission.name);
  }

  /**
   * Invalida cache de acesso de um usuário específico.
   * Melhor esforço: falhas de Redis não propagam para o fluxo de negócio.
   */
  async invalidateUserAccess(userId: string): Promise<void> {
    await this.invalidateUsersAccess([userId]);
  }

  /**
   * Invalida cache de acesso para múltiplos usuários.
   * @returns quantidade de chaves alvo processadas
   */
  async invalidateUsersAccess(userIds: string[]): Promise<number> {
    const normalizedUserIds = [...new Set(userIds.filter(Boolean))];
    const keys = normalizedUserIds.map((userId) =>
      this.getAccessCacheKey(userId),
    );
    if (keys.length === 0) {
      return 0;
    }

    for (const userId of normalizedUserIds) {
      this.localAccessCache.delete(userId);
      this.accessLookupsInFlight.delete(userId);
    }

    try {
      await this.redisService.getClient().del(...keys);
      return keys.length;
    } catch {
      return 0;
    }
  }

  /**
   * Invalida cache de acesso de todos os usuários vinculados a um profile.
   */
  async invalidateUsersByProfileId(profileId: string): Promise<number> {
    if (!profileId) {
      return 0;
    }

    const rows = await this.usersRepository.find({
      where: { profile_id: profileId },
      select: { id: true },
    });

    const userIds = rows
      .map((row) => row.id)
      .filter((value): value is string => typeof value === 'string');

    return this.invalidateUsersAccess(userIds);
  }

  async syncUserRoleFromProfileName(
    userId: string,
    profileName?: string | null,
  ): Promise<void> {
    if (!userId) {
      return;
    }

    const roleName = this.resolveCanonicalRoleName(profileName);
    await this.userRolesRepository.query(
      `
        WITH removed AS (
          DELETE FROM user_roles
          WHERE user_id = $1::uuid
        ),
        target_role AS (
          SELECT id
          FROM roles
          WHERE name = $2
          LIMIT 1
        )
        INSERT INTO user_roles (user_id, role_id)
        SELECT $1::uuid, id
        FROM target_role
        ON CONFLICT (user_id, role_id) DO NOTHING
      `,
      [userId, roleName],
    );
    await this.invalidateUserAccess(userId);
  }

  private async getFallbackAccessFromProfile(
    userId: string,
  ): Promise<AccessBundle> {
    const rows = (await this.usersRepository.query(
      `
        SELECT
          p.nome AS profile_name,
          p.permissoes AS profile_permissions
        FROM users u
        LEFT JOIN profiles p
          ON p.id = u.profile_id
        WHERE u.id = $1
          AND u.deleted_at IS NULL
        LIMIT 1
      `,
      [userId],
    )) as unknown;

    const user = Array.isArray(rows)
      ? ((rows[0] as ProfileFallbackRow | undefined) ?? null)
      : null;
    const profileName = user?.profile_name || undefined;
    const profilePermissions = this.toStringArray(user?.profile_permissions);

    const fallbackPermissions = profileName
      ? PROFILE_PERMISSION_FALLBACK[profileName] || []
      : [];

    return this.normalizeAccessBundle({
      roles: profileName ? [profileName] : [],
      permissions: [
        ...new Set([...fallbackPermissions, ...profilePermissions]),
      ].sort(),
    });
  }

  private async getAccessFromNormalizedRoles(
    userId: string,
  ): Promise<AccessBundle | null> {
    const rows = (await this.userRolesRepository.query(
      `
        SELECT
          COALESCE(
            (
              SELECT array_agg(role_name ORDER BY role_name)
              FROM (
                SELECT DISTINCT r.name AS role_name
                FROM user_roles ur
                INNER JOIN roles r
                  ON r.id = ur.role_id
                WHERE ur.user_id = $1
                  AND r.name IS NOT NULL
              ) role_names
            ),
            ARRAY[]::text[]
          ) AS role_names,
          COALESCE(
            (
              SELECT array_agg(permission_name ORDER BY permission_name)
              FROM (
                SELECT DISTINCT p.name AS permission_name
                FROM user_roles ur
                INNER JOIN role_permissions rp
                  ON rp.role_id = ur.role_id
                INNER JOIN permissions p
                  ON p.id = rp.permission_id
                WHERE ur.user_id = $1
                  AND p.name IS NOT NULL
              ) permission_names
            ),
            ARRAY[]::text[]
          ) AS permission_names
        FROM users u
        WHERE u.id = $1
      `,
      [userId],
    )) as unknown;

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const aggregate = rows[0] as RbacAccessAggregateRow;
    const roleNames = this.toStringArray(aggregate.role_names);
    const rolePermissionNames = this.toStringArray(aggregate.permission_names);
    const fallbackPermissionNames =
      this.getFallbackPermissionsForRoleNames(roleNames);

    if (rolePermissionNames.length === 0 && roleNames.length === 0) {
      return null;
    }

    return this.normalizeAccessBundle({
      roles: roleNames,
      permissions: [
        ...new Set([...rolePermissionNames, ...fallbackPermissionNames]),
      ].sort(),
    });
  }

  private async getModuleAccessPermissionsFromUser(
    userId: string,
  ): Promise<string[]> {
    const rows = (await this.usersRepository.query(
      `
        SELECT module_access_keys
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [userId],
    )) as unknown;

    const user = Array.isArray(rows)
      ? ((rows[0] as ModuleAccessRow | undefined) ?? null)
      : null;

    const moduleKeys = normalizeUserModuleAccessKeys(user?.module_access_keys);
    return resolvePermissionsFromModuleKeys(moduleKeys);
  }

  private getFallbackPermissionsForRoleNames(roleNames: string[]): string[] {
    return [
      ...new Set(
        roleNames.flatMap(
          (roleName) => PROFILE_PERMISSION_FALLBACK[roleName] || [],
        ),
      ),
    ];
  }

  private resolveCanonicalRoleName(profileName?: string | null): string | null {
    if (!profileName) {
      return null;
    }

    const normalized = profileName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ');

    // GERENTE é um papel funcional mais amplo do que SUPERVISOR no fallback
    // do produto. Rebaixar automaticamente para supervisor em user_roles
    // faz o usuário perder permissões válidas quando o banco ainda não tiver
    // um role canônico "Gerente". Nessa fase preferimos preservar o nome do
    // profile e deixar o fallback legado resolver o escopo correto.
    if (normalized === 'GERENTE') {
      return profileName.trim();
    }

    // Usa a util canonica como fonte unica de verdade para todo o resto.
    const canonical = normalizeRoleName(profileName);
    if (!canonical) {
      this.logger.warn(
        `resolveCanonicalRoleName: perfil "${profileName}" não corresponde a nenhum role canônico conhecido. Usando valor bruto — a sincronização de user_roles pode falhar silenciosamente (nenhuma role "${profileName.trim()}" cadastrada).`,
      );
    }
    return canonical ?? profileName.trim();
  }

  private getAccessCacheKey(userId: string): string {
    return `rbac:access:${userId}`;
  }

  private getAccessCacheTtlSeconds(): number {
    const raw = Number(
      process.env.RBAC_ACCESS_CACHE_TTL_SECONDS ||
        DEFAULT_RBAC_ACCESS_CACHE_TTL_SECONDS,
    );

    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }

    return Math.min(Math.floor(raw), 300);
  }

  private normalizeAccessBundle(bundle: AccessBundle): AccessBundle {
    const normalizedRoles = [...new Set(bundle.roles.filter(Boolean))].sort();
    const effectiveScope = this.resolveEffectiveRoleScope(normalizedRoles);
    const isSuperAdmin = effectiveScope === 'SUPER_ADMIN';

    let permissions = bundle.permissions.filter(Boolean);
    if (!isSuperAdmin) {
      permissions = permissions.filter(
        (permission) =>
          !ADMIN_GERAL_ONLY_PERMISSIONS.includes(
            permission as (typeof ADMIN_GERAL_ONLY_PERMISSIONS)[number],
          ),
      );

      if (effectiveScope) {
        const allowed = new Set(
          ROLE_SCOPE_ALLOWED_PERMISSIONS[effectiveScope] || [],
        );
        permissions = permissions.filter((permission) =>
          allowed.has(permission),
        );
      }
    }

    return {
      roles: normalizedRoles,
      permissions: [...new Set(permissions.filter(Boolean))].sort(),
    };
  }

  private resolveEffectiveRoleScope(roles: string[]): RoleScope | null {
    const scopes = roles
      .map((role) => this.resolveRoleScope(role))
      .filter((scope): scope is RoleScope => scope !== null);

    if (scopes.length === 0) {
      return null;
    }

    for (const prioritizedScope of ROLE_SCOPE_PRIORITY) {
      if (scopes.includes(prioritizedScope)) {
        return prioritizedScope;
      }
    }

    return null;
  }

  private resolveRoleScope(roleName: string): RoleScope | null {
    const normalized = roleName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ');

    const aliases: Record<string, RoleScope> = {
      SUPER_ADMIN: 'SUPER_ADMIN',
      'ADMINISTRADOR GERAL': 'ADMIN_EMPRESA',
      ADMIN_GERAL: 'ADMIN_EMPRESA',
      ADMIN_EMPRESA: 'ADMIN_EMPRESA',
      'ADMIN EMPRESA': 'ADMIN_EMPRESA',
      'ADMINISTRADOR DA EMPRESA': 'ADMIN_EMPRESA',
      'ADMINISTRADOR EMPRESA': 'ADMIN_EMPRESA',
      GERENTE: 'GERENTE',
      SUPERVISOR: 'SUPERVISOR',
      'SUPERVISOR / ENCARREGADO': 'SUPERVISOR',
      TECNICO: 'TECNICO',
      'TECNICO SST': 'TECNICO',
      'TECNICO DE SEGURANCA DO TRABALHO': 'TECNICO',
      'TECNICO DE SEGURANCA DO TRABALHO (TST)': 'TECNICO',
      TST: 'TECNICO',
      VISUALIZADOR: 'VISUALIZADOR',
      TRABALHADOR: 'VISUALIZADOR',
      COLABORADOR: 'VISUALIZADOR',
      'OPERADOR / COLABORADOR': 'VISUALIZADOR',
    };

    return aliases[normalized] || null;
  }

  getRoleScope(roleName?: string | null): RoleScope | null {
    if (!roleName) {
      return null;
    }

    return this.resolveRoleScope(roleName);
  }

  getEffectiveRoleScope(roleNames: string[]): RoleScope | null {
    return this.resolveEffectiveRoleScope(roleNames);
  }

  private isAccessBundle(value: unknown): value is AccessBundle {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Partial<AccessBundle>;
    return (
      Array.isArray(candidate.roles) &&
      Array.isArray(candidate.permissions) &&
      candidate.roles.every((item) => typeof item === 'string') &&
      candidate.permissions.every((item) => typeof item === 'string')
    );
  }

  private async getCachedUserAccess(
    userId: string,
  ): Promise<AccessBundle | null> {
    const ttlSeconds = this.getAccessCacheTtlSeconds();
    if (ttlSeconds <= 0) {
      return null;
    }

    try {
      const raw = await this.redisService
        .getClient()
        .get(this.getAccessCacheKey(userId));
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as unknown;
      if (!this.isAccessBundle(parsed)) {
        return null;
      }

      const normalized = this.normalizeAccessBundle(parsed);
      this.setLocalAccess(userId, normalized);
      this.setRequestScopedAccess(userId, normalized);
      this.logAccessResolution('redis_cache_hit', userId);
      return normalized;
    } catch {
      return null;
    }
  }

  private async cacheUserAccess(
    userId: string,
    access: AccessBundle,
  ): Promise<void> {
    this.setLocalAccess(userId, access);
    const ttlSeconds = this.getAccessCacheTtlSeconds();
    if (ttlSeconds <= 0) {
      return;
    }

    try {
      await this.redisService
        .getClient()
        .setex(
          this.getAccessCacheKey(userId),
          ttlSeconds,
          JSON.stringify(access),
        );
    } catch {
      // Cache de RBAC é melhor esforço: falha de Redis não deve bloquear login/sessão.
    }
  }

  private async lookupUserAccess(
    userId: string,
    options?: { profileName?: string | null },
  ): Promise<AccessBundle> {
    const cached = await this.getCachedUserAccess(userId);
    if (cached) {
      return cached;
    }

    const [normalizedAccess, modulePermissions] = await Promise.all([
      this.getAccessFromNormalizedRoles(userId),
      this.getModuleAccessPermissionsFromUser(userId),
    ]);

    if (normalizedAccess) {
      const access = this.normalizeAccessBundle({
        roles: normalizedAccess.roles,
        permissions: [
          ...new Set([...normalizedAccess.permissions, ...modulePermissions]),
        ].sort(),
      });
      await this.cacheUserAccess(userId, access);
      this.logAccessResolution('normalized_roles', userId);
      return access;
    }

    const access = await this.getFallbackAccessFromProfile(userId);
    if (access.roles.length > 0 || access.permissions.length > 0) {
      const mergedAccess = this.normalizeAccessBundle({
        roles: access.roles,
        permissions: [
          ...new Set([...access.permissions, ...modulePermissions]),
        ].sort(),
      });
      await this.cacheUserAccess(userId, mergedAccess);
      this.logAccessResolution('profile_legacy_fallback', userId);
      return mergedAccess;
    }

    // Último recurso: hint de perfil vindo do token/cache de sessão.
    // Nunca deve ter prioridade sobre RBAC/Profiles persistidos no banco.
    const hintedAccess = this.getAccessFromProfileName(options?.profileName);
    if (hintedAccess) {
      const mergedHintedAccess = this.normalizeAccessBundle({
        roles: hintedAccess.roles,
        permissions: [
          ...new Set([...hintedAccess.permissions, ...modulePermissions]),
        ].sort(),
      });
      await this.cacheUserAccess(userId, mergedHintedAccess);
      this.logAccessResolution('profile_hint_cache_only', userId, {
        profileName: options?.profileName || undefined,
      });
      return mergedHintedAccess;
    }

    const mergedEmptyAccess = this.normalizeAccessBundle({
      roles: access.roles,
      permissions: [
        ...new Set([...access.permissions, ...modulePermissions]),
      ].sort(),
    });
    await this.cacheUserAccess(userId, mergedEmptyAccess);
    this.logAccessResolution('empty_access_bundle', userId);
    return mergedEmptyAccess;
  }

  private getAccessFromProfileName(
    profileName?: string | null,
  ): AccessBundle | null {
    const normalizedProfileName = profileName?.trim();
    if (!normalizedProfileName) {
      return null;
    }

    const fallbackPermissions =
      PROFILE_PERMISSION_FALLBACK[normalizedProfileName];
    if (!fallbackPermissions) {
      return null;
    }

    return this.normalizeAccessBundle({
      roles: [normalizedProfileName],
      permissions: [...fallbackPermissions],
    });
  }

  private getRequestScopedAccess(userId: string): AccessBundle | null {
    return RequestContext.get<AccessBundle>(`rbac:request:${userId}`) || null;
  }

  private setRequestScopedAccess(userId: string, access: AccessBundle): void {
    RequestContext.set(`rbac:request:${userId}`, access);
  }

  private getLocalAccess(userId: string): AccessBundle | null {
    const cached = this.localAccessCache.get(userId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.localAccessCache.delete(userId);
      return null;
    }

    return cached.value;
  }

  private setLocalAccess(userId: string, access: AccessBundle): void {
    const ttlMs = this.getLocalAccessCacheTtlMs();
    if (ttlMs <= 0) {
      return;
    }

    this.localAccessCache.set(userId, {
      value: access,
      expiresAt: Date.now() + ttlMs,
    });
  }

  private getLocalAccessCacheTtlMs(): number {
    const raw = Number(process.env.RBAC_ACCESS_LOCAL_CACHE_TTL_SECONDS || 60);

    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }

    return Math.min(Math.floor(raw), 120) * 1000;
  }

  private logAccessResolution(
    source:
      | 'request_cache_hit'
      | 'local_cache_hit'
      | 'redis_cache_hit'
      | 'profile_hint_cache_only'
      | 'normalized_roles'
      | 'profile_legacy_fallback'
      | 'empty_access_bundle',
    userId: string,
    extra?: Record<string, unknown>,
  ): void {
    if (String(process.env.RBAC_ACCESS_DEBUG || '').toLowerCase() !== 'true') {
      return;
    }

    this.logger.debug({
      event: 'rbac_access_resolution',
      source,
      userId,
      requestId: RequestContext.getRequestId(),
      traceId: RequestContext.getTraceId(),
      ...extra,
    });
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    );
  }
}
