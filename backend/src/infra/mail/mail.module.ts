import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import { MailLog } from './entities/mail-log.entity';
import { Cat } from '../../modules/cats/entities/cat.entity';
import { EpisModule } from '../../modules/epis/epis.module';
import { TrainingsModule } from '../../modules/trainings/trainings.module';
import { PtsModule } from '../../modules/pts/pts.module';
import { AprsModule } from '../../modules/aprs/aprs.module';
import { ArrsModule } from '../../modules/arrs/arrs.module';
import { Checklist } from '../../modules/checklists/entities/checklist.entity';
import { NonConformitiesModule } from '../../modules/nonconformities/nonconformities.module';
import { DdsModule } from '../../modules/dds/dds.module';
import { DidsModule } from '../../modules/dids/dids.module';
import { AuditsModule } from '../../modules/audits/audits.module';
import { RdosModule } from '../../modules/rdos/rdos.module';
import { PhotographicReportsModule } from '../../modules/photographic-reports/photographic-reports.module';
import { CompaniesModule } from '../../modules/companies/companies.module';
import { StorageModule } from '../storage/storage.module';
import { ReportsModule } from '../../modules/reports/reports.module';
import { FileInspectionModule } from '../../shared/security/file-inspection.module';
import { createRedisDisabledQueueProvider } from '../queue/redis-disabled-queue';
import { shouldUseRedisQueueInfra } from '../queue/redis-queue-infra.util';
import { MailDlqService } from './mail-dlq.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([MailLog, Cat, Checklist]),
    ...(shouldUseRedisQueueInfra()
      ? [BullModule.registerQueue({ name: 'mail' }, { name: 'mail-dlq' })]
      : []),
    EpisModule,
    forwardRef(() => TrainingsModule),
    forwardRef(() => PtsModule),
    forwardRef(() => AprsModule),
    forwardRef(() => ArrsModule),
    forwardRef(() => NonConformitiesModule),
    forwardRef(() => DdsModule),
    forwardRef(() => DidsModule),
    forwardRef(() => AuditsModule),
    forwardRef(() => RdosModule),
    forwardRef(() => PhotographicReportsModule),
    CompaniesModule,
    StorageModule,
    ReportsModule,
    FileInspectionModule,
  ],
  providers: [
    MailService,
    MailDlqService,
    ...(!shouldUseRedisQueueInfra()
      ? [
          createRedisDisabledQueueProvider('mail'),
          createRedisDisabledQueueProvider('mail-dlq'),
        ]
      : []),
  ],
  controllers: [MailController],
  exports: [MailService, MailDlqService],
})
export class MailModule {}
