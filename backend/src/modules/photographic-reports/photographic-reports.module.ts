import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../../shared/common.module';
import { DocumentRegistryModule } from '../document-registry/document-registry.module';
import { AiModule } from '../ai/ai.module';
import { ConsentsModule } from '../consents/consents.module';
import { SignaturesModule } from '../signatures/signatures.module';
import { FeatureAiGuard } from '../../shared/guards/feature-ai.guard';
import { AiConsentGuard } from '../../shared/guards/ai-consent.guard';
import { PhotographicReportsController } from './photographic-reports.controller';
import { PhotographicReportsService } from './photographic-reports.service';
import { PhotographicReport } from './entities/photographic-report.entity';
import { PhotographicReportDay } from './entities/photographic-report-day.entity';
import { PhotographicReportImage } from './entities/photographic-report-image.entity';
import { PhotographicReportExport } from './entities/photographic-report-export.entity';

@Module({
  imports: [
    CommonModule,
    DocumentRegistryModule,
    AiModule,
    ConsentsModule,
    // Sem ciclo: SignaturesModule importa CommonModule, DocumentRegistryModule,
    // forwardRef(UsersModule) e ForensicTrailModule — nenhum deles alcança
    // photographic-reports.
    SignaturesModule,
    TypeOrmModule.forFeature([
      PhotographicReport,
      PhotographicReportDay,
      PhotographicReportImage,
      PhotographicReportExport,
    ]),
  ],
  controllers: [PhotographicReportsController],
  providers: [PhotographicReportsService, FeatureAiGuard, AiConsentGuard],
  exports: [PhotographicReportsService],
})
export class PhotographicReportsModule {}
