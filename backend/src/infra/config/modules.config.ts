import type { DynamicModule, ForwardReference, Type } from '@nestjs/common';

type NestModule =
  Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference;

/**
 * Catálogo de módulos por domínio de negócio.
 *
 * Objetivo: substituir a lista plana de 50+ imports no app.module.ts por
 * grupos nomeados, tornando o arquivo legível e tornando claro qual domínio
 * é responsável por qual funcionalidade.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COMO ADICIONAR UM NOVO MÓDULO
 * ─────────────────────────────────────────────────────────────────────────
 * 1. Crie a pasta: backend/src/<meu-modulo>/
 * 2. Crie os arquivos: meu-modulo.module.ts, meu-modulo.controller.ts,
 *    meu-modulo.service.ts, dto/, entities/ (se necessário)
 * 3. Crie a migration: backend/src/infra/database/migrations/<timestamp>-create-meu-modulo.ts
 * 4. Adicione o módulo ao grupo correto abaixo.
 * 5. Guards globais e interceptors são aplicados automaticamente — não há
 *    configuração extra necessária no módulo.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * DOMÍNIOS
 * ─────────────────────────────────────────────────────────────────────────
 * IDENTITY       — autenticação, usuários, perfis, permissões (RBAC)
 * TENANT         — empresas, obras, políticas multi-tenant, calendário
 * OPERATIONS     — módulos de campo: APRs, PTSs, DDSs, DIDs, ARRs, etc.
 * COMPLIANCE     — conformidade, qualidade, gestão: auditorias, contratos,
 *                  inspeções, não-conformidades, checklists, relatórios
 * PRIVACY        — LGPD: consentimentos, requisições de privacidade,
 *                  governança de dados
 * COMMUNICATION  — notificações, e-mail, push, assinaturas
 * INFRASTRUCTURE — serviços transversais: comum, Redis, IA, filas,
 *                  observabilidade, segurança, importação de docs,
 *                  dashboard, disaster recovery
 */

// ─── Identity ────────────────────────────────────────────────────────────────
import { AuthModule } from '../../modules/auth/auth.module';
import { UsersModule } from '../../modules/users/users.module';
import { ProfilesModule } from '../../modules/profiles/profiles.module';
import { RbacModule } from '../../modules/rbac/rbac.module';

export const IDENTITY_MODULES: NestModule[] = [
  AuthModule,
  UsersModule,
  ProfilesModule,
  RbacModule,
];

// ─── Tenant ──────────────────────────────────────────────────────────────────
import { CompaniesModule } from '../../modules/companies/companies.module';
import { SitesModule } from '../../modules/sites/sites.module';
import { TenantPoliciesModule } from '../../modules/tenant-policies/tenant-policies.module';
import { CalendarModule } from '../../modules/calendar/calendar.module';
import { TenantLifecycleModule } from '../../modules/tenant-lifecycle/tenant-lifecycle.module';

export const TENANT_MODULES: NestModule[] = [
  CompaniesModule,
  SitesModule,
  TenantPoliciesModule,
  TenantLifecycleModule,
  CalendarModule,
];

// ─── Operations ──────────────────────────────────────────────────────────────
import { ActivitiesModule } from '../../modules/activities/activities.module';
import { RisksModule } from '../../modules/risks/risks.module';
import { EpisModule } from '../../modules/epis/epis.module';
import { ToolsModule } from '../../modules/tools/tools.module';
import { MachinesModule } from '../../modules/machines/machines.module';
import { AprsModule } from '../../modules/aprs/aprs.module';
import { PtsModule } from '../../modules/pts/pts.module';
import { DdsModule } from '../../modules/dds/dds.module';
import { DidsModule } from '../../modules/dids/dids.module';
import { ArrsModule } from '../../modules/arrs/arrs.module';
import { ExpensesModule } from '../../modules/expenses/expenses.module';
import { ServiceOrdersModule } from '../../modules/service-orders/service-orders.module';
import { TrainingsModule } from '../../modules/trainings/trainings.module';
import { MedicalExamsModule } from '../../modules/medical-exams/medical-exams.module';
import { EpiAssignmentsModule } from '../../modules/epi-assignments/epi-assignments.module';

export const OPERATIONS_MODULES: NestModule[] = [
  ActivitiesModule,
  RisksModule,
  EpisModule,
  ToolsModule,
  MachinesModule,
  AprsModule,
  PtsModule,
  DdsModule,
  DidsModule,
  ArrsModule,
  ExpensesModule,
  ServiceOrdersModule,
  TrainingsModule,
  MedicalExamsModule,
  EpiAssignmentsModule,
];

// ─── Compliance ───────────────────────────────────────────────────────────────
import { AuditsModule } from '../../modules/audits/audits.module';
import { NonConformitiesModule } from '../../modules/nonconformities/nonconformities.module';
import { ChecklistsModule } from '../../modules/checklists/checklists.module';
import { RelatoriosModule } from '../../modules/reports/_legacy-relatorios/relatorios.module';
import { ContractsModule } from '../../modules/contracts/contracts.module';
import { DocumentRegistryModule } from '../../modules/document-registry/document-registry.module';
import { CorrectiveActionsModule } from '../../modules/corrective-actions/corrective-actions.module';
import { DossiersModule } from '../../modules/dossiers/dossiers.module';
import { PhotographicReportsModule } from '../../modules/photographic-reports/photographic-reports.module';

export const COMPLIANCE_MODULES: NestModule[] = [
  AuditsModule,
  NonConformitiesModule,
  ChecklistsModule,
  RelatoriosModule,
  ContractsModule,
  DocumentRegistryModule,
  CorrectiveActionsModule,
  DossiersModule,
  PhotographicReportsModule,
];

// ─── Privacy (LGPD) ──────────────────────────────────────────────────────────
import { ConsentsModule } from '../../modules/consents/consents.module';
import { PrivacyRequestsModule } from '../../modules/privacy-requests/privacy-requests.module';
import { PrivacyGovernanceModule } from '../../modules/privacy-governance/privacy-governance.module';
import { AdminModule } from '../../modules/admin/admin.module';

export const PRIVACY_MODULES: NestModule[] = [
  ConsentsModule,
  PrivacyRequestsModule,
  PrivacyGovernanceModule,
  AdminModule,
];

// ─── Communication ───────────────────────────────────────────────────────────
import { MailModule } from '../mail/mail.module';
import { PushModule } from '../push/push.module';
import { SignaturesModule } from '../../modules/signatures/signatures.module';
import { TasksModule } from '../../modules/tasks/tasks.module';

export const COMMUNICATION_MODULES: NestModule[] = [
  MailModule,
  PushModule,
  SignaturesModule,
  TasksModule,
];

// ─── Infrastructure ───────────────────────────────────────────────────────────
import { CommonModule } from '../../shared/common.module';
import { RedisModule } from '../../shared/redis/redis.module';
import { AiModule } from '../../modules/ai/ai.module';
import { DataLoaderModule } from '../../shared/dataloader/dataloader.module';
import { ObservabilityModule } from '../../shared/observability/observability.module';
import { SecurityAuditModule } from '../../shared/security/security-audit.module';
import { FileInspectionModule } from '../../shared/security/file-inspection.module';
import { DocumentImportModule } from '../../modules/document-import/document-import.module';
import { DashboardModule } from '../../modules/dashboard/dashboard.module';
import { DisasterRecoveryModule } from '../../modules/disaster-recovery/disaster-recovery.module';
import { AuditModule } from '../../modules/audit-trail/audit.module';
import { HealthModule } from '../../modules/health/health.module';

export const INFRASTRUCTURE_MODULES: NestModule[] = [
  ObservabilityModule,
  CommonModule,
  RedisModule,
  AiModule,
  DataLoaderModule,
  SecurityAuditModule,
  FileInspectionModule,
  DocumentImportModule,
  DashboardModule,
  DisasterRecoveryModule,
  AuditModule,
  HealthModule,
];

/**
 * Lista completa de feature modules na ordem correta de registro.
 * Infraestrutura primeiro (CommonModule, RedisModule), depois features.
 */
export const ALL_FEATURE_MODULES: NestModule[] = [
  ...INFRASTRUCTURE_MODULES,
  ...IDENTITY_MODULES,
  ...TENANT_MODULES,
  ...OPERATIONS_MODULES,
  ...COMPLIANCE_MODULES,
  ...PRIVACY_MODULES,
  ...COMMUNICATION_MODULES,
];
