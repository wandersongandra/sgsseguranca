import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from './redis/redis.module';
import { TenantService } from './tenant/tenant.service';
import { TenantDbContextService } from './database/tenant-db-context.service';
import { DbTimingsService } from './database/db-timings.service';
import { PrivilegedDbService } from './database/privileged-db.service';
import { ProvisioningDataSourceService } from './database/provisioning-datasource.service';
import { PasswordService } from './services/password.service';
import { CacheService } from './cache/cache.service';
import { PdfService } from './services/pdf.service';
import { PuppeteerPoolService } from './services/puppeteer-pool.service';
import { PdfValidatorService } from './services/pdf-validator.service';
import { SignatureTimestampService } from './services/signature-timestamp.service';
import { TenantRepositoryFactory } from './tenant/tenant-repository';
import { TenantGuard } from './guards/tenant.guard';
import { RiskCalculationService } from './services/risk-calculation.service';
import { DocumentBundleService } from './services/document-bundle.service';
import { DocumentStorageService } from './services/document-storage.service';
import { DocumentRetentionService } from './storage/document-retention.service';
import { PdfIntegrityRecord } from './entities/pdf-integrity-record.entity';
import { DocumentDownloadGrant } from './entities/document-download-grant.entity';
import { PublicValidationGrant } from './entities/public-validation-grant.entity';
import { DocumentRegistryEntry } from '../modules/document-registry/entities/document-registry.entity';
import { Company } from '../modules/companies/entities/company.entity';
import { StorageModule as CommonStorageModule } from './storage/storage.module';
import { ForensicTrailModule } from '../modules/forensic-trail/forensic-trail.module';
import { ForensicAuditInterceptor } from './interceptors/forensic-audit.interceptor';
import { ResilientThrottlerService } from './throttler/resilient-throttler.service';
import { N1QueryDetectorService } from './database/n1-query-detector.service';
import { TenantValidationService } from './tenant/tenant-validation.service';
import { DocumentDownloadGrantService } from './services/document-download-grant.service';
import { PublicValidationGrantService } from './services/public-validation-grant.service';
import { FileInspectionModule } from './security/file-inspection.module';

@Global()
@Module({
  imports: [
    RedisModule,
    CommonStorageModule,
    FileInspectionModule,
    ForensicTrailModule,
    TypeOrmModule.forFeature([
      PdfIntegrityRecord,
      DocumentDownloadGrant,
      PublicValidationGrant,
      DocumentRegistryEntry,
      Company,
    ]),
  ],
  providers: [
    TenantService,
    TenantValidationService,
    TenantRepositoryFactory,
    TenantGuard,
    TenantDbContextService,
    DbTimingsService,
    PrivilegedDbService,
    ProvisioningDataSourceService,
    PasswordService,
    CacheService,
    PdfService,
    PuppeteerPoolService,
    PdfValidatorService,
    SignatureTimestampService,
    RiskCalculationService,
    DocumentDownloadGrantService,
    PublicValidationGrantService,
    DocumentStorageService,
    DocumentRetentionService,
    DocumentBundleService,
    ForensicAuditInterceptor,
    ResilientThrottlerService,
    N1QueryDetectorService,
  ],
  exports: [
    RedisModule,
    FileInspectionModule,
    TypeOrmModule,
    TenantService,
    TenantValidationService,
    TenantRepositoryFactory,
    TenantGuard,
    TenantDbContextService,
    DbTimingsService,
    PrivilegedDbService,
    ProvisioningDataSourceService,
    PasswordService,
    CacheService,
    PdfService,
    PuppeteerPoolService,
    PdfValidatorService,
    SignatureTimestampService,
    RiskCalculationService,
    DocumentDownloadGrantService,
    PublicValidationGrantService,
    DocumentStorageService,
    DocumentRetentionService,
    DocumentBundleService,
    ForensicTrailModule,
    ForensicAuditInterceptor,
    ResilientThrottlerService,
    N1QueryDetectorService,
  ],
})
export class CommonModule {}
