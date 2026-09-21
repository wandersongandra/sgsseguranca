import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CleanupTask } from './cleanup.task';
import { DocumentRetentionScheduler } from './document-retention.scheduler';
import { GdprRetentionCleanupScheduler } from './gdpr-retention-cleanup.scheduler';
import { TrialLifecycleScheduler } from './trial-lifecycle.scheduler';
import { AdminModule } from '../admin/admin.module';
import { CompaniesModule } from '../companies/companies.module';
import { QueueServicesModule } from '../../infra/queue/queue-services.module';
import { MailModule } from '../../infra/mail/mail.module';

/**
 * Worker-only module.
 *
 * Regra: nenhum scheduler/cron pesado deve rodar no runtime web (HTTP).
 * Este módulo concentra tasks agendadas que:
 * - limpam dados temporários/logs
 * - enfileiram jobs por tenant
 * - executam o ciclo de vida de trial (expiração + notificações D-7/D-3/D-1)
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'sla-escalation' },
      { name: 'expiry-notifications' },
      { name: 'document-retention' },
      { name: 'pdf-generation-dlq' },
    ),
    QueueServicesModule,
    CompaniesModule,
    AdminModule,
    forwardRef(() => MailModule),
  ],
  providers: [
    CleanupTask,
    DocumentRetentionScheduler,
    GdprRetentionCleanupScheduler,
    TrialLifecycleScheduler,
  ],
})
export class TasksWorkerModule {}
