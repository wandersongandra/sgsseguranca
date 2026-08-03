import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule } from '../../shared/common.module';
import { DocumentRegistryModule } from '../document-registry/document-registry.module';
import { AiModule } from '../ai/ai.module';
import { ConsentsModule } from '../consents/consents.module';
import { FeatureAiGuard } from '../../shared/guards/feature-ai.guard';
import { AiConsentGuard } from '../../shared/guards/ai-consent.guard';
import { MailModule } from '../../infra/mail/mail.module';
import { PhotographicReportsController } from './photographic-reports.controller';
import { PhotographicReportsService } from './photographic-reports.service';
import { PhotographicReport } from './entities/photographic-report.entity';
import { PhotographicReportDay } from './entities/photographic-report-day.entity';
import { PhotographicReportImage } from './entities/photographic-report-image.entity';
import { PhotographicReportExport } from './entities/photographic-report-export.entity';
import { shouldUseRedisQueueInfra } from '../../infra/queue/redis-queue-infra.util';
import { createRedisDisabledQueueProvider } from '../../infra/queue/redis-disabled-queue';

@Module({
  imports: [
    CommonModule,
    DocumentRegistryModule,
    AiModule,
    ConsentsModule,
    forwardRef(() => MailModule),
    TypeOrmModule.forFeature([
      PhotographicReport,
      PhotographicReportDay,
      PhotographicReportImage,
      PhotographicReportExport,
    ]),
    ...(shouldUseRedisQueueInfra()
      ? [BullModule.registerQueue({ name: 'mail' })]
      : []),
  ],
  controllers: [PhotographicReportsController],
  providers: [
    PhotographicReportsService,
    FeatureAiGuard,
    AiConsentGuard,
    ...(!shouldUseRedisQueueInfra()
      ? [createRedisDisabledQueueProvider('mail')]
      : []),
  ],
  exports: [PhotographicReportsService],
})
export class PhotographicReportsModule {}
