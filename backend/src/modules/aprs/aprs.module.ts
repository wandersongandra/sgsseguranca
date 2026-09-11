import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AprsService } from './aprs.service';
import { AprsController } from './aprs.controller';
import { Apr } from './entities/apr.entity';
import { AprLog } from './entities/apr-log.entity';
import { AprApprovalStep } from './entities/apr-approval-step.entity';
import { AprRiskItem } from './entities/apr-risk-item.entity';
import { AprRiskEvidence } from './entities/apr-risk-evidence.entity';
import { AprFeatureFlag } from './entities/apr-feature-flag.entity';
import { AprMetric } from './entities/apr-metric.entity';
import { AprWorkflowConfig } from './entities/apr-workflow-config.entity';
import { AprWorkflowStep } from './entities/apr-workflow-step.entity';
import { AprApprovalRecord } from './entities/apr-approval-record.entity';
import { AprRule } from './entities/apr-rule.entity';
import { AprRulesEngineService } from './services/apr-rules-engine.service';
import { CommonModule } from '../../shared/common.module';
import { AuthModule } from '../auth/auth.module';
import { Company } from '../companies/entities/company.entity';
import { StorageModule } from '../../shared/storage/storage.module';
import { DocumentRegistryModule } from '../document-registry/document-registry.module';
import { PublicAprEvidenceController } from './public-apr-evidence.controller';
import { PublicAprVerificationController } from './public-apr-verification.controller';
import { SignaturesModule } from '../signatures/signatures.module';
import { AprRiskMatrixService } from './apr-risk-matrix.service';
import { AprExcelService } from './apr-excel.service';
import { ForensicTrailModule } from '../forensic-trail/forensic-trail.module';
import { AprsPdfService } from './services/aprs-pdf.service';
import { AprsEvidenceService } from './services/aprs-evidence.service';
import { AprWorkflowService } from './aprs-workflow.service';
import { FileInspectionModule } from '../../shared/security/file-inspection.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AprFeatureFlagService } from './services/apr-feature-flag.service';
import { AprMetricsService } from './services/apr-metrics.service';
import { AprFeatureFlagGuard } from './guards/apr-feature-flag.guard';
import { AprMetricsInterceptor } from './interceptors/apr-metrics.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Apr,
      AprLog,
      AprApprovalStep,
      AprRiskItem,
      AprRiskEvidence,
      Company,
      AprFeatureFlag,
      AprMetric,
      AprWorkflowConfig,
      AprWorkflowStep,
      AprApprovalRecord,
      AprRule,
    ]),
    CommonModule,
    NotificationsModule,
    forwardRef(() => AuthModule),
    StorageModule,
    DocumentRegistryModule,
    SignaturesModule,
    ForensicTrailModule,
    FileInspectionModule,
  ],
  controllers: [
    AprsController,
    PublicAprEvidenceController,
    PublicAprVerificationController,
  ],
  providers: [
    AprsService,
    AprRiskMatrixService,
    AprExcelService,
    AprsPdfService,
    AprsEvidenceService,
    AprWorkflowService,
    AprFeatureFlagService,
    AprMetricsService,
    AprFeatureFlagGuard,
    AprMetricsInterceptor,
    AprRulesEngineService,
  ],
  exports: [
    AprsService,
    AprWorkflowService,
    AprFeatureFlagService,
    AprMetricsService,
  ],
})
export class AprsModule {}
