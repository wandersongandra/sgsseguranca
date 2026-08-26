import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageController } from './storage.controller';
import { CommonModule } from '../../shared/common.module';
import { AuditModule } from '../../modules/audit-trail/audit.module';
import { FileInspectionModule } from '../../shared/security/file-inspection.module';

@Module({
  imports: [ConfigModule, CommonModule, AuditModule, FileInspectionModule],
  controllers: [StorageController],
})
export class StorageModule {}
