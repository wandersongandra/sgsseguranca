import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { EpisModule } from '../epis/epis.module';
import { AprsModule } from '../aprs/aprs.module';
import { PtsModule } from '../pts/pts.module';
import { RisksModule } from '../risks/risks.module';
import { TrainingsModule } from '../trainings/trainings.module';
import { ChecklistsModule } from '../checklists/checklists.module';
import { UsersModule } from '../users/users.module';
import { MedicalExamsModule } from '../medical-exams/medical-exams.module';
import { CatsModule } from '../cats/cats.module';
import { NonConformitiesModule } from '../nonconformities/nonconformities.module';
import { ServiceOrdersModule } from '../service-orders/service-orders.module';
import { DdsModule } from '../dds/dds.module';
import { ActivitiesModule } from '../activities/activities.module';
import { ToolsModule } from '../tools/tools.module';
import { MachinesModule } from '../machines/machines.module';

// SST Agent
import { AiInteraction } from './entities/ai-interaction.entity';
import { SstAgentService } from './sst-agent/sst-agent.service';
import { SstAgentController } from './sst-agent/sst-agent.controller';
import { SstToolsExecutor } from './sst-agent/sst-agent.tools';
import { SstRateLimitService } from './sst-agent/sst-rate-limit.service';
import { SophieFacadeService } from './sophie-facade.service';
import { AiAnalysisService } from './services/ai-analysis.service';
import { SophieModule } from '../sophie/sophie.module';
import { FeatureAiGuard } from '../../shared/guards/feature-ai.guard';
import { AiConsentGuard } from '../../shared/guards/ai-consent.guard';
import { ConsentsModule } from '../consents/consents.module';
import { User } from '../users/entities/user.entity';
import { FileInspectionModule } from '../../shared/security/file-inspection.module';
import { createRedisDisabledQueueProvider } from '../../infra/queue/redis-disabled-queue';
import { shouldUseRedisQueueInfra } from '../../infra/queue/redis-queue-infra.util';

@Module({
  imports: [
    TypeOrmModule.forFeature([AiInteraction, User]),
    FileInspectionModule,
    ...(shouldUseRedisQueueInfra()
      ? [
          BullModule.registerQueue({ name: 'pdf-generation' }),
          BullModule.registerQueue({ name: 'ai-recovery' }),
        ]
      : []),
    SophieModule,
    ConsentsModule,
    EpisModule,
    AprsModule,
    PtsModule,
    RisksModule,
    TrainingsModule,
    ChecklistsModule,
    forwardRef(() => UsersModule),
    forwardRef(() => MedicalExamsModule),
    CatsModule,
    NonConformitiesModule,
    ServiceOrdersModule,
    DdsModule,
    ActivitiesModule,
    ToolsModule,
    MachinesModule,
  ],
  controllers: [AiController, SstAgentController],
  providers: [
    AiService,
    AiAnalysisService,
    SstAgentService,
    SstToolsExecutor,
    SstRateLimitService,
    SophieFacadeService,
    FeatureAiGuard,
    AiConsentGuard,
    ...(!shouldUseRedisQueueInfra()
      ? [
          createRedisDisabledQueueProvider('pdf-generation'),
          createRedisDisabledQueueProvider('ai-recovery', {
            addMode: 'noop',
          }),
        ]
      : []),
  ],
  exports: [AiService, AiAnalysisService, SstAgentService, SophieFacadeService],
})
export class AiModule {}
