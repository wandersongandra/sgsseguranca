import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PdfService } from '../../shared/services/pdf.service';
import { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { DocumentRegistryService } from './document-registry.service';
import { DocumentRegistryEntry } from './entities/document-registry.entity';
import { WeeklyBundleFilters } from '../../shared/services/document-bundle.service';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';

type GovernedModule =
  | 'apr'
  | 'pt'
  | 'dds'
  | 'did'
  | 'arr'
  | 'report'
  | 'photographic_report'
  | 'training'
  | 'checklist'
  | 'cat'
  | 'dossier'
  | 'audit'
  | 'nonconformity'
  | 'rdo';

type RegisterFinalDocumentInput = {
  companyId: string;
  module: GovernedModule;
  entityId: string;
  title: string;
  documentDate?: Date | string | null;
  fileKey: string;
  folderPath?: string | null;
  originalName?: string | null;
  mimeType?: string | null;
  fileBuffer: Buffer;
  createdBy?: string | null;
  documentCode?: string | null;
  documentType?: string;
  persistEntityMetadata?: (
    manager: EntityManager,
    hash: string,
  ) => Promise<void>;
};

type SyncFinalDocumentMetadataInput = Omit<
  RegisterFinalDocumentInput,
  'fileBuffer'
> & {
  fileHash?: string | null;
};

type RemoveFinalDocumentReferenceInput = {
  companyId: string;
  module: GovernedModule;
  entityId: string;
  documentType?: string;
  removeEntityState?: (manager: EntityManager) => Promise<void>;
  cleanupStoredFile?: (fileKey: string) => Promise<void>;
  trailEventType?: string;
  trailMetadata?: Record<string, unknown>;
};

const signatureDocumentTypeToRegistryModule = new Map<string, GovernedModule>([
  ['APR', 'apr'],
  ['PT', 'pt'],
  ['DDS', 'dds'],
  ['ARR', 'arr'],
  ['ANALISE_DE_RISCO_RAPIDA', 'arr'],
  ['TRAINING', 'training'],
  ['TREINAMENTO', 'training'],
  ['TRN', 'training'],
  ['CHECKLIST', 'checklist'],
  ['CAT', 'cat'],
  ['AUDIT', 'audit'],
  ['AUDITORIA', 'audit'],
  ['NONCONFORMITY', 'nonconformity'],
  ['NAO_CONFORMIDADE', 'nonconformity'],
  ['NC', 'nonconformity'],
  ['RDO', 'rdo'],
  ['PHOTOGRAPHIC_REPORT', 'photographic_report'],
  ['RELATORIO_FOTOGRAFICO', 'photographic_report'],
  ['RFP', 'photographic_report'],
]);

function normalizeSignatureDocumentType(documentType: string): string {
  return String(documentType || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function resolveRegistryModuleForSignatureDocumentType(
  documentType: string,
): GovernedModule | null {
  return (
    signatureDocumentTypeToRegistryModule.get(
      normalizeSignatureDocumentType(documentType),
    ) || null
  );
}

@Injectable()
export class DocumentGovernanceService {
  private readonly logger = new Logger(DocumentGovernanceService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pdfService: PdfService,
    private readonly documentBundleService: DocumentBundleService,
    private readonly documentRegistryService: DocumentRegistryService,
    private readonly forensicTrailService: ForensicTrailService,
  ) {}

  async registerFinalDocument(
    input: RegisterFinalDocumentInput,
  ): Promise<{ hash: string; registryEntry: DocumentRegistryEntry }> {
    const hash = this.pdfService.computeHash(input.fileBuffer);

    try {
      return await this.dataSource.transaction(async (manager) => {
        // O upload externo já ocorreu fora deste bloco. Daqui em diante,
        // mantemos a persistência relacional (entidade + integridade +
        // registry) dentro da mesma transação para evitar estado parcial.
        if (input.persistEntityMetadata) {
          await input.persistEntityMetadata(manager, hash);
        }

        await this.pdfService.registerHashIntegrity(
          hash,
          {
            originalName: input.originalName || input.title,
            recordedByUserId: input.createdBy || null,
            companyId: input.companyId,
          },
          { manager },
        );

        const registryEntry =
          await this.documentRegistryService.upsertWithManager(manager, {
            companyId: input.companyId,
            module: input.module,
            entityId: input.entityId,
            title: input.title,
            documentDate: input.documentDate,
            fileKey: input.fileKey,
            folderPath: input.folderPath,
            originalName: input.originalName,
            mimeType: input.mimeType,
            fileHash: hash,
            documentCode: input.documentCode,
            createdBy: input.createdBy,
            documentType: input.documentType,
          });

        await this.forensicTrailService.append(
          {
            eventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REGISTERED,
            module: input.module,
            entityId: input.entityId,
            companyId: input.companyId,
            userId: input.createdBy || null,
            metadata: {
              registryEntryId: registryEntry.id,
              documentCode: registryEntry.document_code,
              documentType: registryEntry.document_type,
              title: registryEntry.title,
              fileKey: registryEntry.file_key,
              folderPath: registryEntry.folder_path,
              originalName: registryEntry.original_name,
              mimeType: registryEntry.mime_type,
              fileHash: registryEntry.file_hash,
            },
          },
          { manager },
        );

        return { hash, registryEntry };
      });
    } catch (error) {
      this.logger.error(
        `Falha ao registrar governança documental para ${input.module}:${input.entityId}. O upload externo, se já concluído, deve ser revisado manualmente (${input.fileKey}).`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async syncFinalDocumentMetadata(
    input: SyncFinalDocumentMetadataInput,
  ): Promise<DocumentRegistryEntry> {
    return this.documentRegistryService.upsert({
      companyId: input.companyId,
      module: input.module,
      entityId: input.entityId,
      title: input.title,
      documentDate: input.documentDate,
      fileKey: input.fileKey,
      folderPath: input.folderPath,
      originalName: input.originalName,
      mimeType: input.mimeType,
      fileHash: input.fileHash,
      documentCode: input.documentCode,
      createdBy: input.createdBy,
      documentType: input.documentType,
    });
  }

  async listFinalDocuments(
    module: GovernedModule,
    filters: WeeklyBundleFilters,
  ): Promise<
    Array<{
      entityId: string;
      id: string;
      title: string;
      date: Date | null;
      companyId: string;
      fileKey: string;
      folderPath: string;
      originalName: string;
      module: GovernedModule;
    }>
  > {
    const entries = await this.documentRegistryService.list({
      ...filters,
      modules: [module],
    });

    return entries.map((entry) => ({
      entityId: entry.entity_id,
      id: entry.entity_id,
      title: entry.title,
      date: entry.document_date,
      companyId: entry.company_id,
      fileKey: entry.file_key,
      folderPath: entry.folder_path || '',
      originalName:
        entry.original_name ||
        entry.file_key.split('/').pop() ||
        'documento.pdf',
      module,
    }));
  }

  async removeFinalDocumentReference(
    input: RemoveFinalDocumentReferenceInput,
  ): Promise<void> {
    const registryEntry = await this.documentRegistryService.findByDocument(
      input.module,
      input.entityId,
      input.documentType || 'pdf',
      input.companyId,
    );

    await this.dataSource.transaction(async (manager) => {
      if (input.removeEntityState) {
        await input.removeEntityState(manager);
      }

      // Policy atual: ao excluir o documento de negócio, o registry é removido
      // para não manter o documento como ativo/localizável, mas o registro de
      // integridade permanece para rastreabilidade histórica por hash.
      await this.documentRegistryService.removeWithManager(manager, {
        companyId: input.companyId,
        module: input.module,
        entityId: input.entityId,
        documentType: input.documentType,
      });

      await this.forensicTrailService.append(
        {
          eventType:
            input.trailEventType || FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
          module: input.module,
          entityId: input.entityId,
          companyId: input.companyId,
          metadata: {
            documentType: input.documentType || 'pdf',
            hadGovernedFile: Boolean(registryEntry),
            registryEntryId: registryEntry?.id || null,
            documentCode: registryEntry?.document_code || null,
            fileKey: registryEntry?.file_key || null,
            folderPath: registryEntry?.folder_path || null,
            originalName: registryEntry?.original_name || null,
            fileHash: registryEntry?.file_hash || null,
            ...(input.trailMetadata || {}),
          },
        },
        { manager },
      );
    });

    if (registryEntry?.file_key && input.cleanupStoredFile) {
      try {
        await input.cleanupStoredFile(registryEntry.file_key);
      } catch (error) {
        this.logger.warn(
          `Registry removido para ${input.module}:${input.entityId}, mas a limpeza do arquivo físico falhou (${registryEntry.file_key}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.debug(
      `Registry removido para ${input.module}:${input.entityId}; registro de integridade preservado por rastreabilidade histórica.`,
    );
  }

  async getModuleWeeklyBundle(
    module: GovernedModule,
    bundleName: string,
    filters: WeeklyBundleFilters,
  ) {
    const files = await this.listFinalDocuments(module, filters);

    return this.documentBundleService.buildWeeklyPdfBundle(
      bundleName,
      filters,
      files.map((file) => ({
        fileKey: file.fileKey,
        title: file.title,
        originalName: file.originalName,
        date: file.date,
      })),
    );
  }

  async findRegistryContextForSignature(
    documentId: string,
    documentType: string,
    companyId?: string | null,
  ): Promise<{
    registryEntryId: string;
    documentCode: string | null;
    fileHash: string | null;
    fileKey: string;
    module: GovernedModule;
  } | null> {
    const registryModule =
      resolveRegistryModuleForSignatureDocumentType(documentType);

    if (!registryModule) {
      this.logger.warn(
        `Tipo documental sem mapeamento para contexto de assinatura: "${documentType}" (${documentId}).`,
      );
      return null;
    }

    const entry = await this.documentRegistryService.findByDocument(
      registryModule,
      documentId,
      'pdf',
      companyId || undefined,
    );

    if (!entry) {
      this.logger.debug(
        `Registry não localizado para assinatura de ${registryModule}:${documentId}${companyId ? ` (company=${companyId})` : ''}.`,
      );
      return null;
    }

    return {
      registryEntryId: entry.id,
      documentCode: entry.document_code,
      fileHash: entry.file_hash,
      fileKey: entry.file_key,
      module: registryModule,
    };
  }
}
