import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Body,
  Req,
  Get,
  Param,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { PdfService } from '../../../shared/services/pdf.service';
import { PdfRateLimitService } from '../services/pdf-rate-limit.service';
import { Request } from 'express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import {
  assertUploadedPdf,
  cleanupUploadedTempFile,
  createGovernedPdfUploadOptions,
} from '../../../shared/interceptors/file-upload.interceptor';
import { Authorize } from '../authorize.decorator';
import { FileInspectionService } from '../../../shared/security/file-inspection.service';
import { getRequestIp } from '../../../shared/utils/request-ip.util';

interface PdfSecurityRequestUser {
  id?: string;
  userId?: string;
  company_id?: string;
  companyId?: string;
}

type PdfSecurityRequest = Request & {
  user: PdfSecurityRequestUser;
};

const resolvePdfSecurityActor = (
  req: PdfSecurityRequest,
): { userId: string; companyId: string | null } => {
  const userId = req.user.id ?? req.user.userId;

  if (!userId) {
    throw new UnauthorizedException('Usuário autenticado inválido.');
  }

  return {
    userId,
    companyId: req.user.company_id ?? req.user.companyId ?? null,
  };
};

const resolvePdfSecurityCompanyId = (req: PdfSecurityRequest): string | null =>
  req.user.company_id ?? req.user.companyId ?? null;

@ApiTags('PDF Security')
@Controller('pdf-security')
@UseGuards(JwtAuthGuard)
export class PdfSecurityController {
  constructor(
    private readonly pdfService: PdfService,
    private readonly pdfRateLimitService: PdfRateLimitService,
    private readonly fileInspectionService: FileInspectionService,
  ) {}

  @Post('sign')
  @Authorize('can_manage_signatures')
  @UseInterceptors(
    FileInterceptor('file', createGovernedPdfUploadOptions(25 * 1024 * 1024)),
  )
  @ApiOperation({
    summary: 'Sign a PDF file and register it for security tracking',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        originalName: {
          type: 'string',
        },
      },
    },
  })
  async signPdf(
    @UploadedFile() file: Express.Multer.File,
    @Body('originalName') originalName: string,
    @Req() req: PdfSecurityRequest,
  ) {
    const pdfFile = await assertUploadedPdf(
      file,
      'File is required',
      this.fileInspectionService,
    );
    const { userId, companyId } = resolvePdfSecurityActor(req);
    const ip = getRequestIp(req) ?? 'unknown';

    // Check rate limit (Mass Download Detection)
    try {
      await this.pdfRateLimitService.checkDownloadLimit(userId, ip);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new UnauthorizedException(
        error instanceof Error ? error.message : 'Rate limit exceeded',
      );
    }

    // Sign and save hash
    try {
      const hash = await this.pdfService.signAndSave(pdfFile.buffer, {
        originalName: originalName || pdfFile.originalname,
        signedByUserId: userId,
        companyId,
      });

      return {
        status: 'success',
        hash,
        message: 'PDF signed and registered successfully',
      };
    } finally {
      await cleanupUploadedTempFile(pdfFile);
    }
  }

  @Get('verify/:hash')
  @ApiOperation({ summary: 'Verify a PDF file integrity by hash' })
  @Authorize('can_view_signatures')
  async verifyPdf(@Param('hash') hash: string, @Req() req: PdfSecurityRequest) {
    const companyId = resolvePdfSecurityCompanyId(req);
    if (!companyId) {
      throw new BadRequestException(
        'Contexto de empresa obrigatório para verificar a integridade do PDF.',
      );
    }

    const result = await this.pdfService.verifyForCompany(hash, companyId);
    return result;
  }
}
