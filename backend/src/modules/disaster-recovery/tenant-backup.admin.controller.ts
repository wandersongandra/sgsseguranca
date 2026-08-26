import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { open } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { resolveSgsTempDirectory } from '../../shared/temp-directory.util';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { Authorize } from '../auth/authorize.decorator';
import { TenantOptional } from '../../shared/decorators/tenant-optional.decorator';
import {
  SensitiveAction,
  SensitiveActionGuard,
} from '../../shared/security/sensitive-action.guard';
import { cleanupUploadedTempFile } from '../../shared/interceptors/file-upload.interceptor';
import { withDefaultJobOptions } from '../../infra/queue/default-job-options';
import { TenantRestoreDto } from './dto/tenant-restore.dto';
import { TenantBackupService } from './tenant-backup.service';
import type { TenantBackupJobData } from './tenant-backup.types';

type RequestUser = {
  user?: {
    userId?: string;
    id?: string;
    sub?: string;
  };
};

const tenantBackupJobOptions = withDefaultJobOptions({
  timeout: 30 * 60 * 1000,
});

const TENANT_BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 200;
const TENANT_BACKUP_FILE_EXTENSIONS = ['.json.gz', '.gz'];
const TENANT_BACKUP_UPLOAD_DIR = path.resolve(
  resolveSgsTempDirectory(),
  'tenant-backups',
);

const tenantBackupUploadOptions: MulterOptions = {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      mkdirSync(TENANT_BACKUP_UPLOAD_DIR, { recursive: true });
      cb(null, TENANT_BACKUP_UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const extension = resolveTenantBackupUploadExtension(file.originalname);
      cb(null, `${randomUUID()}${extension}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const originalName = String(file.originalname || '').toLowerCase();
    const mimeType = String(file.mimetype || '').toLowerCase();
    const hasAcceptedExtension = TENANT_BACKUP_FILE_EXTENSIONS.some((ext) =>
      originalName.endsWith(ext),
    );
    const hasAcceptedMime =
      mimeType === 'application/gzip' ||
      mimeType === 'application/x-gzip' ||
      mimeType === 'application/octet-stream' ||
      mimeType.length === 0;

    cb(null, hasAcceptedExtension && hasAcceptedMime);
  },
  limits: {
    fileSize: TENANT_BACKUP_UPLOAD_MAX_BYTES,
  },
};

function resolveTenantBackupUploadExtension(originalName?: string): string {
  const normalized = String(originalName || '').toLowerCase();
  if (normalized.endsWith('.json.gz')) {
    return '.json.gz';
  }
  if (normalized.endsWith('.gz')) {
    return '.gz';
  }
  return '.json.gz';
}

function resolveTenantBackupUploadedPath(filePath: string): string {
  const resolvedBase = path.resolve(TENANT_BACKUP_UPLOAD_DIR);
  const resolvedFile = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedBase, filePath);
  const relativePath = path.relative(resolvedBase, resolvedFile);
  const isInside =
    relativePath.length === 0 ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));

  if (!isInside) {
    throw new BadRequestException('Caminho de upload de backup inválido.');
  }

  return resolvedFile;
}

@Controller('admin')
@TenantOptional()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class TenantBackupAdminController {
  private readonly logger = new Logger(TenantBackupAdminController.name);

  constructor(
    private readonly tenantBackupService: TenantBackupService,
    @InjectQueue('tenant-backup') private readonly tenantBackupQueue: Queue,
  ) {}

  @Post('tenants/:id/backup')
  @Authorize('can_manage_disaster_recovery')
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('tenant_backup')
  async triggerTenantBackup(
    @Param('id', new ParseUUIDPipe()) companyId: string,
    @Req() req: RequestUser,
  ) {
    const requestedByUserId = this.resolveRequestUserId(req);
    const data: TenantBackupJobData = {
      type: 'backup_tenant',
      companyId,
      triggerSource: 'manual',
      requestedByUserId: requestedByUserId || undefined,
    };

    try {
      const job = await this.tenantBackupQueue.add(
        'backup-tenant',
        data,
        tenantBackupJobOptions,
      );

      return {
        job_id: String(job.id),
        queue: this.tenantBackupService.getQueueName(),
        status_url: `/admin/jobs/${job.id}/status`,
      };
    } catch {
      const result = await this.tenantBackupService.backupTenant(companyId, {
        triggerSource: 'manual',
        requestedByUserId: requestedByUserId || undefined,
      });
      return {
        mode: 'inline',
        result,
      };
    }
  }

  @Get('tenants/:id/backups')
  @Authorize('can_manage_disaster_recovery')
  listTenantBackups(@Param('id', new ParseUUIDPipe()) companyId: string) {
    return this.tenantBackupService.listBackups(companyId);
  }

  @Post('tenants/:id/restore')
  @Authorize('can_manage_disaster_recovery')
  @UseGuards(SensitiveActionGuard)
  @SensitiveAction('tenant_restore')
  @UseInterceptors(FileInterceptor('file', tenantBackupUploadOptions))
  async restoreTenantBackup(
    @Param('id', new ParseUUIDPipe()) sourceCompanyId: string,
    @Body() body: TenantRestoreDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: RequestUser,
  ) {
    const hasUpload = Boolean(file?.path);
    if (!body.backup_id && !hasUpload) {
      throw new BadRequestException(
        'Informe backup_id ou envie o arquivo de backup para restore.',
      );
    }
    if (body.mode === 'clone_to_new_tenant' && !body.target_company_id) {
      throw new BadRequestException(
        'target_company_id é obrigatório para clone_to_new_tenant.',
      );
    }
    if (hasUpload) {
      try {
        await this.assertUploadedBackupFile(file);
      } catch (error) {
        await cleanupUploadedTempFile(file, this.logger);
        throw error;
      }
    }

    const requestedByUserId = this.resolveRequestUserId(req);
    const restoreInput: TenantBackupJobData & { type: 'restore_tenant' } = {
      type: 'restore_tenant',
      sourceCompanyId,
      mode: body.mode,
      targetCompanyId: body.target_company_id,
      backupId: body.backup_id,
      backupFilePath: file?.path,
      requestedByUserId: requestedByUserId || undefined,
      confirmCompanyId: body.confirm_company_id,
      confirmPhrase: body.confirm_phrase,
      targetCompanyName: body.target_company_name,
      targetCompanyCnpj: body.target_company_cnpj,
    };

    if (hasUpload) {
      const result = await this.tenantBackupService.restoreBackup({
        sourceCompanyId,
        mode: body.mode,
        targetCompanyId: body.target_company_id,
        backupId: body.backup_id,
        backupFilePath: file?.path,
        requestedByUserId: requestedByUserId || undefined,
        confirmCompanyId: body.confirm_company_id,
        confirmPhrase: body.confirm_phrase,
        targetCompanyName: body.target_company_name,
        targetCompanyCnpj: body.target_company_cnpj,
      });

      return {
        mode: 'inline',
        result,
      };
    }

    try {
      const job = await this.tenantBackupQueue.add(
        'restore-tenant',
        restoreInput,
        tenantBackupJobOptions,
      );
      return {
        job_id: String(job.id),
        queue: this.tenantBackupService.getQueueName(),
        status_url: `/admin/jobs/${job.id}/status`,
      };
    } catch {
      const result = await this.tenantBackupService.restoreBackup({
        sourceCompanyId,
        mode: body.mode,
        targetCompanyId: body.target_company_id,
        backupId: body.backup_id,
        requestedByUserId: requestedByUserId || undefined,
        confirmCompanyId: body.confirm_company_id,
        confirmPhrase: body.confirm_phrase,
        targetCompanyName: body.target_company_name,
        targetCompanyCnpj: body.target_company_cnpj,
      });
      return {
        mode: 'inline',
        result,
      };
    }
  }

  @Get('jobs/:jobId/status')
  @Authorize('can_manage_disaster_recovery')
  async getTenantBackupJobStatus(@Param('jobId') jobId: string) {
    const job = await this.tenantBackupQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} não encontrado.`);
    }

    const state = await job.getState();
    return {
      id: String(job.id),
      name: job.name,
      state,
      queue: this.tenantBackupService.getQueueName(),
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason || null,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      finishedAt: job.finishedOn
        ? new Date(job.finishedOn).toISOString()
        : null,
      result: (job.returnvalue as unknown) ?? null,
    };
  }

  private resolveRequestUserId(req: RequestUser): string | null {
    return req.user?.userId || req.user?.id || req.user?.sub || null;
  }

  private async assertUploadedBackupFile(
    file: Express.Multer.File | undefined,
  ): Promise<void> {
    if (!file?.path) {
      throw new BadRequestException('Arquivo de backup não recebido.');
    }

    const originalName = String(file.originalname || '').toLowerCase();
    if (
      !TENANT_BACKUP_FILE_EXTENSIONS.some((ext) => originalName.endsWith(ext))
    ) {
      throw new BadRequestException(
        'Arquivo de restore deve usar extensão .json.gz.',
      );
    }

    // lgtm[js/path-injection]
    const uploadPath = resolveTenantBackupUploadedPath(file.path);
    const handle = await open(uploadPath, 'r');
    try {
      const sample = Buffer.alloc(2);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      const isGzip =
        bytesRead === 2 && sample[0] === 0x1f && sample[1] === 0x8b;
      if (!isGzip) {
        throw new BadRequestException(
          'Arquivo de backup inválido: assinatura gzip ausente.',
        );
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
