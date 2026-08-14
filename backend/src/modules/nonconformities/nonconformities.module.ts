import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NonConformitiesService } from './nonconformities.service';
import { NonConformitiesPdfService } from './services/nonconformities-pdf.service';
import { NonConformityWorkflowLockService } from './services/nonconformity-workflow-lock.service';
import { NonConformitiesController } from './nonconformities.controller';
import { NonConformity } from './entities/nonconformity.entity';
import { CommonModule } from '../../shared/common.module';
import { Company } from '../companies/entities/company.entity';
import { AuditModule } from '../audit-trail/audit.module';
import { DocumentRegistryModule } from '../document-registry/document-registry.module';
import { Site } from '../sites/entities/site.entity';
import { Checklist } from '../checklists/entities/checklist.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([NonConformity, Company, Site, Checklist]),
    CommonModule,
    AuditModule,
    DocumentRegistryModule,
  ],
  controllers: [NonConformitiesController],
  providers: [
    NonConformitiesService,
    NonConformitiesPdfService,
    NonConformityWorkflowLockService,
  ],
  exports: [NonConformitiesService, NonConformitiesPdfService],
})
export class NonConformitiesModule {}
