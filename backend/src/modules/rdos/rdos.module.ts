import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Rdo } from './entities/rdo.entity';
import { RdoAuditEvent } from './entities/rdo-audit-event.entity';
import { RdosController } from './rdos.controller';
import { RdosService } from './rdos.service';
import { RdoAuditService } from './rdo-audit.service';
import { MailModule } from '../../infra/mail/mail.module';
import { DocumentRegistryModule } from '../document-registry/document-registry.module';
import { AuthModule } from '../auth/auth.module';
import { ForensicTrailModule } from '../forensic-trail/forensic-trail.module';
import { CommonModule } from '../../shared/common.module';
import { DocumentVideosModule } from '../document-videos/document-videos.module';
import { shouldUseRedisQueueInfra } from '../../infra/queue/redis-queue-infra.util';
import { createRedisDisabledQueueProvider } from '../../infra/queue/redis-disabled-queue';

@Module({
  imports: [
    TypeOrmModule.forFeature([Rdo, RdoAuditEvent]),
    forwardRef(() => MailModule),
    DocumentRegistryModule,
    forwardRef(() => AuthModule),
    ForensicTrailModule,
    CommonModule,
    DocumentVideosModule,
    ...(shouldUseRedisQueueInfra()
      ? [BullModule.registerQueue({ name: 'mail' })]
      : []),
  ],
  controllers: [RdosController],
  providers: [
    RdosService,
    RdoAuditService,
    ...(!shouldUseRedisQueueInfra()
      ? [createRedisDisabledQueueProvider('mail')]
      : []),
  ],
  exports: [RdosService],
})
export class RdosModule {}
