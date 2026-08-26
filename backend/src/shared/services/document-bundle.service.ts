import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DocumentStorageService } from './document-storage.service';

export interface WeeklyBundleFilters {
  companyId?: string;
  year?: number;
  week?: number;
}

export interface WeeklyBundleDocument {
  fileKey: string;
  resourceType: string;
  resourceId: string;
  title: string;
  originalName?: string | null;
  date?: string | Date | null;
}

@Injectable()
export class DocumentBundleService {
  private readonly logger = new Logger(DocumentBundleService.name);

  constructor(
    private readonly documentStorageService: DocumentStorageService,
  ) {}

  async buildWeeklyPdfBundle(
    moduleName: string,
    filters: WeeklyBundleFilters,
    documents: WeeklyBundleDocument[],
  ): Promise<{ buffer: Buffer; fileName: string }> {
    if (!filters.year || !filters.week) {
      throw new BadRequestException(
        'Ano e semana são obrigatórios para gerar o pacote semanal.',
      );
    }

    if (documents.length === 0) {
      throw new NotFoundException(
        'Nenhum documento PDF encontrado para a semana informada.',
      );
    }

    const mergedPdf = await PDFDocument.create();
    const titleFont = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
    const textFont = await mergedPdf.embedFont(StandardFonts.Helvetica);
    const sortedDocuments = [...documents].sort((left, right) => {
      return this.getDateValue(left.date) - this.getDateValue(right.date);
    });

    const skipped: string[] = [];
    let importedDocuments = 0;
    let storageUnavailable = false;

    for (const document of sortedDocuments) {
      try {
        const fileBuffer = await this.documentStorageService.downloadFileBuffer(
          this.documentStorageService.referenceForExistingObject(
            document.fileKey,
            {
              resourceType: document.resourceType,
              resourceId: document.resourceId,
            },
            'p1-document-storage-downloadFileBuffer',
          ),
        );
        const sourcePdf = await PDFDocument.load(fileBuffer);
        const pages = await mergedPdf.copyPages(
          sourcePdf,
          sourcePdf.getPageIndices(),
        );
        pages.forEach((page) => mergedPdf.addPage(page));
        importedDocuments += 1;
      } catch (error) {
        if (
          error instanceof ServiceUnavailableException ||
          (error instanceof HttpException && error.getStatus() === 503)
        ) {
          storageUnavailable = true;
        }
        skipped.push(
          document.originalName || document.title || document.fileKey,
        );
        this.logger.warn({
          event: 'weekly_bundle_document_skipped',
          moduleName,
          keyFingerprint: this.diagnosticFingerprint(document.fileKey),
          errorName: error instanceof Error ? error.name : 'unknown_error',
        });
      }
    }

    if (importedDocuments === 0) {
      if (storageUnavailable) {
        throw new ServiceUnavailableException({
          error: 'DOCUMENT_STORAGE_UNAVAILABLE',
          message:
            'Armazenamento documental indisponível. Não foi possível montar o pacote semanal.',
        });
      }

      throw new NotFoundException(
        'Nenhum PDF válido foi encontrado para compor o pacote semanal.',
      );
    }

    const coverPage = mergedPdf.insertPage(0);
    const { width, height } = coverPage.getSize();

    coverPage.drawRectangle({
      x: 0,
      y: 0,
      width,
      height,
      color: rgb(0.96, 0.95, 0.94),
    });

    coverPage.drawText('SGS', {
      x: 48,
      y: height - 72,
      size: 24,
      font: titleFont,
      color: rgb(0.12, 0.16, 0.22),
    });

    coverPage.drawText(`Pacote semanal - ${moduleName}`, {
      x: 48,
      y: height - 112,
      size: 18,
      font: titleFont,
      color: rgb(0.29, 0.27, 0.25),
    });

    const metadataLines = [
      `Semana ISO: ${String(filters.week).padStart(2, '0')}/${filters.year}`,
      `Empresa: ${filters.companyId || 'tenant atual'}`,
      `Documentos incluídos: ${importedDocuments}`,
      `Documentos ignorados: ${skipped.length}`,
      `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
    ];

    metadataLines.forEach((line, index) => {
      coverPage.drawText(line, {
        x: 48,
        y: height - 160 - index * 22,
        size: 11,
        font: textFont,
        color: rgb(0.29, 0.33, 0.39),
      });
    });

    coverPage.drawText('Índice de documentos', {
      x: 48,
      y: height - 298,
      size: 14,
      font: titleFont,
      color: rgb(0.12, 0.16, 0.22),
    });

    sortedDocuments.slice(0, 18).forEach((document, index) => {
      const label = `${index + 1}. ${document.title || document.originalName || document.fileKey}`;
      const dateLabel = this.formatDate(document.date);
      coverPage.drawText(`${label}${dateLabel ? ` - ${dateLabel}` : ''}`, {
        x: 48,
        y: height - 326 - index * 16,
        size: 10,
        font: textFont,
        color: rgb(0.29, 0.33, 0.39),
      });
    });

    if (sortedDocuments.length > 18) {
      coverPage.drawText(
        `... e mais ${sortedDocuments.length - 18} documento(s) no pacote.`,
        {
          x: 48,
          y: 78,
          size: 10,
          font: textFont,
          color: rgb(0.29, 0.33, 0.39),
        },
      );
    }

    if (skipped.length > 0) {
      coverPage.drawText(
        'Observação: alguns PDFs inválidos ou indisponíveis foram ignorados durante a montagem.',
        {
          x: 48,
          y: 56,
          size: 9,
          font: textFont,
          color: rgb(0.78, 0.33, 0.11),
        },
      );
    }

    const pdfBytes = await mergedPdf.save();
    const fileName = this.buildFileName(moduleName, filters);

    return {
      buffer: Buffer.from(pdfBytes),
      fileName,
    };
  }

  private diagnosticFingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private getDateValue(date?: string | Date | null): number {
    if (!date) return Number.MAX_SAFE_INTEGER;
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime())
      ? Number.MAX_SAFE_INTEGER
      : parsed.getTime();
  }

  private formatDate(date?: string | Date | null): string {
    if (!date) return '';
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }
    return parsed.toLocaleDateString('pt-BR');
  }

  private buildFileName(
    moduleName: string,
    filters: WeeklyBundleFilters,
  ): string {
    const safeModuleName = moduleName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    return `${safeModuleName || 'documentos'}-semana-${filters.year}-${String(filters.week).padStart(2, '0')}.pdf`;
  }
}
