import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Apr } from '../aprs/entities/apr.entity';
import { Audit } from '../audits/entities/audit.entity';
import { Cat } from '../cats/entities/cat.entity';
import { Checklist } from '../checklists/entities/checklist.entity';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { Dds } from '../dds/entities/dds.entity';
import {
  DocumentRegistryEntry,
  DocumentRegistryStatus,
} from '../document-registry/entities/document-registry.entity';
import { Inspection } from '../../shared/entities/inspection.entity';
import { NonConformity } from '../nonconformities/entities/nonconformity.entity';
import { Pt } from '../pts/entities/pt.entity';
import { Rdo } from '../rdos/entities/rdo.entity';
import type { StorageObjectOwner } from '../../shared/storage/storage-object-reference';
import {
  DashboardDocumentAvailabilityPendencyType,
  DashboardDocumentAvailabilitySnapshot,
  DashboardDocumentAvailabilitySnapshotKind,
  DashboardDocumentAvailabilityStatus,
} from './entities/dashboard-document-availability-snapshot.entity';

type LightweightDocumentMetadata = {
  companyId: string;
  siteId: string | null;
  status: string | null;
  documentCode: string | null;
  title: string | null;
};

type NcGovernedAttachmentReferencePayload = {
  v: 1;
  kind: 'governed-storage';
  fileKey: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  sizeBytes?: number | null;
};

type SnapshotRefreshStatus = {
  hasRows: boolean;
  lastCheckedAt: Date | null;
  stale: boolean;
};

type SnapshotRefreshStatusRow = {
  row_count?: number | string | null;
  last_checked_at?: string | Date | null;
};

type TrackableSnapshotSourcesRow = {
  has_registry_documents?: boolean | 't' | 'f' | 1 | 0 | null;
  has_cat_attachments?: boolean | 't' | 'f' | 1 | 0 | null;
  has_nonconformity_attachments?: boolean | 't' | 'f' | 1 | 0 | null;
};

export type DashboardDocumentAvailabilityReadiness = SnapshotRefreshStatus & {
  readable: boolean;
  hasTrackableObjects: boolean;
  refreshScheduled: boolean;
};

type DashboardDocumentAvailabilitySnapshotInput = Pick<
  DashboardDocumentAvailabilitySnapshot,
  | 'company_id'
  | 'pendency_type'
  | 'snapshot_kind'
  | 'module'
  | 'object_key'
  | 'document_id'
  | 'site_id'
  | 'file_key'
  | 'original_name'
  | 'document_code'
  | 'title'
  | 'status'
  | 'relevant_date'
  | 'attachment_id'
  | 'attachment_index'
  | 'availability_status'
  | 'last_checked_at'
  | 'last_error'
>;

const NC_GOVERNED_ATTACHMENT_PREFIX = 'gst:nc-attachment:';
const DEFAULT_DASHBOARD_STORAGE_SNAPSHOT_REFRESH_TTL_MS = 5 * 60 * 1000;
const STORAGE_SNAPSHOT_CHECK_CONCURRENCY = 4;

@Injectable()
export class DashboardDocumentAvailabilitySnapshotService {
  private readonly logger = new Logger(
    DashboardDocumentAvailabilitySnapshotService.name,
  );
  private readonly inFlightRefreshes = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(Apr)
    private readonly aprsRepository: Repository<Apr>,
    @InjectRepository(Audit)
    private readonly auditsRepository: Repository<Audit>,
    @InjectRepository(Cat)
    private readonly catsRepository: Repository<Cat>,
    @InjectRepository(Checklist)
    private readonly checklistsRepository: Repository<Checklist>,
    @InjectRepository(Dds)
    private readonly ddsRepository: Repository<Dds>,
    @InjectRepository(DocumentRegistryEntry)
    private readonly documentRegistryRepository: Repository<DocumentRegistryEntry>,
    @InjectRepository(Inspection)
    private readonly inspectionsRepository: Repository<Inspection>,
    @InjectRepository(NonConformity)
    private readonly nonConformitiesRepository: Repository<NonConformity>,
    @InjectRepository(Pt)
    private readonly ptsRepository: Repository<Pt>,
    @InjectRepository(Rdo)
    private readonly rdosRepository: Repository<Rdo>,
    @InjectRepository(DashboardDocumentAvailabilitySnapshot)
    private readonly snapshotRepository: Repository<DashboardDocumentAvailabilitySnapshot>,
    private readonly documentStorageService: DocumentStorageService,
  ) {}

  async ensureSnapshotsAvailable(input: {
    companyId?: string;
    shouldCollect: boolean;
  }): Promise<void> {
    if (!input.shouldCollect || !input.companyId) {
      return;
    }

    const refreshStatus = await this.getRefreshStatus(input.companyId);
    if (!refreshStatus.hasRows) {
      if (await this.hasTrackableSnapshotSources(input.companyId)) {
        await this.refreshCompany(input.companyId);
      }
      return;
    }

    if (refreshStatus.stale) {
      await this.refreshCompany(input.companyId);
    }
  }

  async scheduleRefreshIfNeeded(input: {
    companyId?: string;
    shouldCollect: boolean;
  }): Promise<DashboardDocumentAvailabilityReadiness> {
    if (!input.shouldCollect || !input.companyId) {
      return {
        hasRows: false,
        lastCheckedAt: null,
        stale: false,
        readable: true,
        hasTrackableObjects: false,
        refreshScheduled: false,
      };
    }

    const refreshStatus = await this.getRefreshStatus(input.companyId);
    if (refreshStatus.hasRows) {
      const refreshScheduled = refreshStatus.stale
        ? this.scheduleRefreshCompany(input.companyId)
        : false;
      return {
        ...refreshStatus,
        readable: true,
        hasTrackableObjects: true,
        refreshScheduled,
      };
    }

    const hasTrackableObjects = await this.hasTrackableSnapshotSources(
      input.companyId,
    );
    const refreshScheduled = hasTrackableObjects
      ? this.scheduleRefreshCompany(input.companyId)
      : false;

    return {
      ...refreshStatus,
      readable: !hasTrackableObjects,
      hasTrackableObjects,
      refreshScheduled,
    };
  }

  private scheduleRefreshCompany(companyId: string): boolean {
    if (this.inFlightRefreshes.has(companyId)) {
      return false;
    }

    void this.refreshCompany(companyId).catch((error) => {
      this.logger.warn({
        event: 'dashboard_document_availability_refresh_scheduled_failed',
        companyId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  async listUnavailableSnapshots(input: {
    companyId?: string;
    siteId?: string;
    module?: string;
    pendencyTypes?: DashboardDocumentAvailabilityPendencyType[];
    status?: string;
    dateFrom?: Date;
    dateTo?: Date;
  }): Promise<DashboardDocumentAvailabilitySnapshot[]> {
    const qb = this.snapshotRepository
      .createQueryBuilder('snapshot')
      .where('snapshot.availability_status = :availability', {
        availability:
          DashboardDocumentAvailabilityStatus.REGISTERED_WITHOUT_SIGNED_URL,
      });

    if (input.companyId) {
      qb.andWhere('snapshot.company_id = :companyId', {
        companyId: input.companyId,
      });
    }

    if (input.siteId) {
      qb.andWhere('snapshot.site_id = :siteId', { siteId: input.siteId });
    }

    if (input.module) {
      qb.andWhere('snapshot.module = :module', { module: input.module });
    }

    if (input.pendencyTypes && input.pendencyTypes.length > 0) {
      qb.andWhere('snapshot.pendency_type IN (:...pendencyTypes)', {
        pendencyTypes: input.pendencyTypes,
      });
    }

    if (input.status) {
      qb.andWhere("LOWER(COALESCE(snapshot.status, '')) = LOWER(:status)", {
        status: input.status,
      });
    }

    if (input.dateFrom) {
      qb.andWhere('snapshot.relevant_date >= :dateFrom', {
        dateFrom: input.dateFrom,
      });
    }

    if (input.dateTo) {
      qb.andWhere('snapshot.relevant_date <= :dateTo', {
        dateTo: input.dateTo,
      });
    }

    return qb
      .orderBy('snapshot.relevant_date', 'DESC', 'NULLS LAST')
      .addOrderBy('snapshot.module', 'ASC')
      .addOrderBy('snapshot.document_id', 'ASC')
      .getMany();
  }

  private async getRefreshStatus(
    companyId: string,
  ): Promise<SnapshotRefreshStatus> {
    const row = await this.querySingleRow<SnapshotRefreshStatusRow>(
      `
        SELECT
          COUNT(*)::int AS row_count,
          MAX(last_checked_at) AS last_checked_at
        FROM dashboard_document_availability_snapshots
        WHERE company_id = $1
      `,
      [companyId],
    );
    const rowCount = Number(row?.row_count || 0);
    const lastCheckedAt = row?.last_checked_at
      ? new Date(row.last_checked_at)
      : null;

    return {
      hasRows: rowCount > 0,
      lastCheckedAt,
      stale: this.isSnapshotStale(lastCheckedAt),
    };
  }

  private async hasTrackableSnapshotSources(
    companyId: string,
  ): Promise<boolean> {
    const row = await this.querySingleRow<TrackableSnapshotSourcesRow>(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM document_registry registry
            WHERE registry.company_id = $1
              AND registry.document_type = 'pdf'
              AND registry.status = $2
            LIMIT 1
          ) AS has_registry_documents,
          EXISTS (
            SELECT 1
            FROM cats cat
            WHERE cat.company_id = $1
              AND jsonb_array_length(COALESCE(cat.attachments, '[]'::jsonb)) > 0
            LIMIT 1
          ) AS has_cat_attachments,
          EXISTS (
            SELECT 1
            FROM nonconformities nc
            WHERE nc.company_id = $1
              AND nc.deleted_at IS NULL
              AND jsonb_typeof(COALESCE(nc.anexos, '[]'::jsonb)) = 'array'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(nc.anexos, '[]'::jsonb)) AS attachment(value)
                WHERE attachment.value LIKE $3
              )
            LIMIT 1
          ) AS has_nonconformity_attachments
      `,
      [
        companyId,
        DocumentRegistryStatus.ACTIVE,
        `${NC_GOVERNED_ATTACHMENT_PREFIX}%`,
      ],
    );

    return (
      this.toBoolean(row?.has_registry_documents) ||
      this.toBoolean(row?.has_cat_attachments) ||
      this.toBoolean(row?.has_nonconformity_attachments)
    );
  }

  private isSnapshotStale(lastCheckedAt: Date | null): boolean {
    if (!lastCheckedAt) {
      return true;
    }

    return (
      Date.now() - lastCheckedAt.getTime() >
      DEFAULT_DASHBOARD_STORAGE_SNAPSHOT_REFRESH_TTL_MS
    );
  }

  private async refreshCompany(companyId: string): Promise<void> {
    const existing = this.inFlightRefreshes.get(companyId);
    if (existing) {
      await existing;
      return;
    }

    const refreshPromise = this.doRefreshCompany(companyId).finally(() => {
      this.inFlightRefreshes.delete(companyId);
    });
    this.inFlightRefreshes.set(companyId, refreshPromise);
    await refreshPromise;
  }

  private async doRefreshCompany(companyId: string): Promise<void> {
    const [registryEntries, cats, nonConformities] = await Promise.all([
      this.documentRegistryRepository.find({
        where: {
          company_id: companyId,
          document_type: 'pdf',
          status: DocumentRegistryStatus.ACTIVE,
        },
        order: { created_at: 'DESC' },
      }),
      this.catsRepository.find({
        where: { company_id: companyId },
        select: [
          'id',
          'company_id',
          'site_id',
          'numero',
          'status',
          'attachments',
          'updated_at',
        ],
      }),
      this.nonConformitiesRepository.find({
        where: {
          company_id: companyId,
          deleted_at: IsNull(),
        },
        select: [
          'id',
          'company_id',
          'site_id',
          'codigo_nc',
          'status',
          'anexos',
          'updated_at',
        ],
      }),
    ]);

    const [registrySnapshots, catSnapshots, nonConformitySnapshots] =
      await Promise.all([
        this.buildRegistrySnapshots(registryEntries),
        this.buildCatAttachmentSnapshots(cats),
        this.buildNonConformityAttachmentSnapshots(nonConformities),
      ]);

    const snapshots = [
      ...registrySnapshots,
      ...catSnapshots,
      ...nonConformitySnapshots,
    ];

    if (snapshots.length > 0) {
      await this.snapshotRepository.upsert(snapshots, [
        'company_id',
        'snapshot_kind',
        'object_key',
      ]);
    }

    await Promise.all([
      this.cleanupSnapshotKind(
        companyId,
        DashboardDocumentAvailabilitySnapshotKind.REGISTRY_DOCUMENT,
        registrySnapshots.map((snapshot) => snapshot.object_key),
      ),
      this.cleanupSnapshotKind(
        companyId,
        DashboardDocumentAvailabilitySnapshotKind.CAT_ATTACHMENT,
        catSnapshots.map((snapshot) => snapshot.object_key),
      ),
      this.cleanupSnapshotKind(
        companyId,
        DashboardDocumentAvailabilitySnapshotKind.NONCONFORMITY_ATTACHMENT,
        nonConformitySnapshots.map((snapshot) => snapshot.object_key),
      ),
    ]);

    this.logger.log({
      event: 'dashboard_document_availability_snapshots_refreshed',
      companyId,
      registryCount: registrySnapshots.length,
      catAttachmentCount: catSnapshots.length,
      nonConformityAttachmentCount: nonConformitySnapshots.length,
    });
  }

  private async cleanupSnapshotKind(
    companyId: string,
    snapshotKind: DashboardDocumentAvailabilitySnapshotKind,
    objectKeys: string[],
  ): Promise<void> {
    const qb = this.snapshotRepository
      .createQueryBuilder()
      .delete()
      .from(DashboardDocumentAvailabilitySnapshot)
      .where('company_id = :companyId', { companyId })
      .andWhere('snapshot_kind = :snapshotKind', { snapshotKind });

    if (objectKeys.length > 0) {
      qb.andWhere('object_key NOT IN (:...objectKeys)', { objectKeys });
    }

    await qb.execute();
  }

  private async buildRegistrySnapshots(
    registryEntries: DocumentRegistryEntry[],
  ): Promise<DashboardDocumentAvailabilitySnapshotInput[]> {
    if (registryEntries.length === 0) {
      return [];
    }

    const metadataMap = await this.loadDocumentMetadata(
      registryEntries.map((entry) => ({
        module: entry.module,
        documentId: entry.entity_id,
      })),
    );

    const now = new Date();
    const snapshots = await this.mapWithConcurrency(
      registryEntries,
      STORAGE_SNAPSHOT_CHECK_CONCURRENCY,
      async (entry) => {
        const check = await this.resolveAvailability({
          kind: DashboardDocumentAvailabilitySnapshotKind.REGISTRY_DOCUMENT,
          fileKey: entry.file_key,
          owner: {
            resourceType: entry.module,
            resourceId: entry.entity_id,
          },
        });
        const metadata =
          metadataMap.get(
            this.buildMetadataMapKey(entry.module, entry.entity_id),
          ) || null;

        return {
          company_id: metadata?.companyId || entry.company_id,
          pendency_type:
            DashboardDocumentAvailabilityPendencyType.DEGRADED_DOCUMENT_AVAILABILITY,
          snapshot_kind:
            DashboardDocumentAvailabilitySnapshotKind.REGISTRY_DOCUMENT,
          module: entry.module,
          object_key: entry.id,
          document_id: entry.entity_id,
          site_id: metadata?.siteId || null,
          file_key: entry.file_key,
          original_name: entry.original_name || null,
          document_code: entry.document_code || metadata?.documentCode || null,
          title: entry.title || metadata?.title || null,
          status: metadata?.status || 'emitido',
          relevant_date: this.toDateOrNull(
            entry.document_date || entry.created_at,
          ),
          attachment_id: null,
          attachment_index: null,
          availability_status: check.available
            ? DashboardDocumentAvailabilityStatus.READY
            : DashboardDocumentAvailabilityStatus.REGISTERED_WITHOUT_SIGNED_URL,
          last_checked_at: now,
          last_error: check.errorMessage,
        } satisfies DashboardDocumentAvailabilitySnapshotInput;
      },
    );

    return snapshots;
  }

  private async buildCatAttachmentSnapshots(
    cats: Cat[],
  ): Promise<DashboardDocumentAvailabilitySnapshotInput[]> {
    const nestedSnapshots = await this.mapWithConcurrency(
      cats,
      STORAGE_SNAPSHOT_CHECK_CONCURRENCY,
      async (cat) => {
        const attachments = Array.isArray(cat.attachments)
          ? cat.attachments
          : [];
        const now = new Date();

        return this.mapWithConcurrency(
          attachments,
          STORAGE_SNAPSHOT_CHECK_CONCURRENCY,
          async (attachment) => {
            const check = await this.resolveAvailability({
              kind: DashboardDocumentAvailabilitySnapshotKind.CAT_ATTACHMENT,
              fileKey: attachment.file_key,
              owner: {
                resourceType: 'cat-attachment',
                resourceId: cat.id,
              },
            });

            return {
              company_id: cat.company_id,
              pendency_type:
                DashboardDocumentAvailabilityPendencyType.UNAVAILABLE_GOVERNED_ATTACHMENT,
              snapshot_kind:
                DashboardDocumentAvailabilitySnapshotKind.CAT_ATTACHMENT,
              module: 'cat',
              object_key: attachment.id || `${cat.id}:${attachment.file_key}`,
              document_id: cat.id,
              site_id: cat.site_id || null,
              file_key: attachment.file_key,
              original_name: attachment.file_name || null,
              document_code: cat.numero,
              title: `CAT ${cat.numero}`,
              status: cat.status,
              relevant_date: this.toDateOrNull(
                attachment.uploaded_at || cat.updated_at || null,
              ),
              attachment_id: attachment.id || null,
              attachment_index: null,
              availability_status: check.available
                ? DashboardDocumentAvailabilityStatus.READY
                : DashboardDocumentAvailabilityStatus.REGISTERED_WITHOUT_SIGNED_URL,
              last_checked_at: now,
              last_error: check.errorMessage,
            } satisfies DashboardDocumentAvailabilitySnapshotInput;
          },
        );
      },
    );

    return nestedSnapshots.flat();
  }

  private async buildNonConformityAttachmentSnapshots(
    nonConformities: NonConformity[],
  ): Promise<DashboardDocumentAvailabilitySnapshotInput[]> {
    const nestedSnapshots = await this.mapWithConcurrency(
      nonConformities,
      STORAGE_SNAPSHOT_CHECK_CONCURRENCY,
      async (nonConformity) => {
        const governedAttachments = (nonConformity.anexos || [])
          .map((value, index) => ({
            index,
            payload: this.parseNcGovernedAttachmentReference(value),
          }))
          .filter(
            (
              entry,
            ): entry is {
              index: number;
              payload: NcGovernedAttachmentReferencePayload;
            } => Boolean(entry.payload),
          );
        const now = new Date();

        return this.mapWithConcurrency(
          governedAttachments,
          STORAGE_SNAPSHOT_CHECK_CONCURRENCY,
          async ({ index, payload }) => {
            const check = await this.resolveAvailability({
              kind: DashboardDocumentAvailabilitySnapshotKind.NONCONFORMITY_ATTACHMENT,
              fileKey: payload.fileKey,
              owner: {
                resourceType: 'nc-attachment',
                resourceId: nonConformity.id,
              },
            });

            return {
              company_id: nonConformity.company_id,
              pendency_type:
                DashboardDocumentAvailabilityPendencyType.UNAVAILABLE_GOVERNED_ATTACHMENT,
              snapshot_kind:
                DashboardDocumentAvailabilitySnapshotKind.NONCONFORMITY_ATTACHMENT,
              module: 'nonconformity',
              object_key: `${nonConformity.id}:${index}`,
              document_id: nonConformity.id,
              site_id: nonConformity.site_id || null,
              file_key: payload.fileKey,
              original_name: payload.originalName,
              document_code: nonConformity.codigo_nc,
              title: `NC ${nonConformity.codigo_nc}`,
              status: nonConformity.status,
              relevant_date: this.toDateOrNull(
                payload.uploadedAt || nonConformity.updated_at || null,
              ),
              attachment_id: null,
              attachment_index: index,
              availability_status: check.available
                ? DashboardDocumentAvailabilityStatus.READY
                : DashboardDocumentAvailabilityStatus.REGISTERED_WITHOUT_SIGNED_URL,
              last_checked_at: now,
              last_error: check.errorMessage,
            } satisfies DashboardDocumentAvailabilitySnapshotInput;
          },
        );
      },
    );

    return nestedSnapshots.flat();
  }

  private async resolveAvailability(input: {
    kind: DashboardDocumentAvailabilitySnapshotKind;
    fileKey: string;
    owner: StorageObjectOwner;
  }): Promise<{ available: boolean; errorMessage: string | null }> {
    try {
      await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          input.fileKey,
          input.owner,
          'p1-document-storage-getSignedUrl',
        ),
      );

      return { available: true, errorMessage: null };
    } catch (error) {
      return {
        available: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseNcGovernedAttachmentReference(
    value?: string | null,
  ): NcGovernedAttachmentReferencePayload | null {
    if (!value?.startsWith(NC_GOVERNED_ATTACHMENT_PREFIX)) {
      return null;
    }

    try {
      const decoded = Buffer.from(
        value.slice(NC_GOVERNED_ATTACHMENT_PREFIX.length),
        'base64url',
      ).toString('utf8');
      const payload = JSON.parse(
        decoded,
      ) as NcGovernedAttachmentReferencePayload;
      if (
        payload?.kind !== 'governed-storage' ||
        typeof payload.fileKey !== 'string' ||
        typeof payload.originalName !== 'string' ||
        typeof payload.mimeType !== 'string'
      ) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private async loadDocumentMetadata(
    entries: Array<{ module: string; documentId: string }>,
  ): Promise<Map<string, LightweightDocumentMetadata>> {
    const groupedIds = entries.reduce<Map<string, Set<string>>>(
      (accumulator, entry) => {
        if (!entry.module || !entry.documentId) {
          return accumulator;
        }
        const current = accumulator.get(entry.module) || new Set<string>();
        current.add(entry.documentId);
        accumulator.set(entry.module, current);
        return accumulator;
      },
      new Map<string, Set<string>>(),
    );

    const metadata = new Map<string, LightweightDocumentMetadata>();

    const assignMany = <T extends { id: string }>(
      module: string,
      rows: T[],
      project: (row: T) => LightweightDocumentMetadata,
    ) => {
      for (const row of rows) {
        metadata.set(this.buildMetadataMapKey(module, row.id), project(row));
      }
    };

    const aprIds = Array.from(groupedIds.get('apr') || []);
    if (aprIds.length > 0) {
      assignMany(
        'apr',
        await this.aprsRepository.find({
          where: { id: In(aprIds) },
          select: ['id', 'company_id', 'site_id', 'status', 'numero', 'titulo'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id,
          status: row.status,
          documentCode: row.numero,
          title: row.titulo,
        }),
      );
    }

    const ptIds = Array.from(groupedIds.get('pt') || []);
    if (ptIds.length > 0) {
      assignMany(
        'pt',
        await this.ptsRepository.find({
          where: { id: In(ptIds) },
          select: ['id', 'company_id', 'site_id', 'status', 'numero', 'titulo'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id,
          status: row.status,
          documentCode: row.numero,
          title: row.titulo,
        }),
      );
    }

    const ddsIds = Array.from(groupedIds.get('dds') || []);
    if (ddsIds.length > 0) {
      assignMany(
        'dds',
        await this.ddsRepository.find({
          where: { id: In(ddsIds) },
          select: ['id', 'company_id', 'site_id', 'status', 'tema'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id,
          status: row.status,
          documentCode: null,
          title: row.tema,
        }),
      );
    }

    const checklistIds = Array.from(groupedIds.get('checklist') || []);
    if (checklistIds.length > 0) {
      assignMany(
        'checklist',
        await this.checklistsRepository.find({
          where: { id: In(checklistIds) },
          select: ['id', 'company_id', 'site_id', 'status', 'titulo'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id || null,
          status: row.status,
          documentCode: null,
          title: row.titulo,
        }),
      );
    }

    const inspectionIds = Array.from(groupedIds.get('inspection') || []);
    if (inspectionIds.length > 0) {
      assignMany(
        'inspection',
        await this.inspectionsRepository.find({
          where: { id: In(inspectionIds) },
          select: ['id', 'company_id', 'site_id', 'setor_area'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id,
          status: 'emitido',
          documentCode: null,
          title: row.setor_area,
        }),
      );
    }

    const rdoIds = Array.from(groupedIds.get('rdo') || []);
    if (rdoIds.length > 0) {
      assignMany(
        'rdo',
        await this.rdosRepository.find({
          where: { id: In(rdoIds) },
          select: ['id', 'company_id', 'site_id', 'status', 'numero'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id || null,
          status: row.status,
          documentCode: row.numero,
          title: `RDO ${row.numero}`,
        }),
      );
    }

    const catIds = Array.from(groupedIds.get('cat') || []);
    if (catIds.length > 0) {
      assignMany(
        'cat',
        await this.catsRepository.find({
          where: { id: In(catIds) },
          select: ['id', 'company_id', 'site_id', 'status', 'numero'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id || null,
          status: row.status,
          documentCode: row.numero,
          title: `CAT ${row.numero}`,
        }),
      );
    }

    const auditIds = Array.from(groupedIds.get('audit') || []);
    if (auditIds.length > 0) {
      assignMany(
        'audit',
        await this.auditsRepository.find({
          where: { id: In(auditIds) },
          select: ['id', 'company_id', 'site_id', 'titulo'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id,
          status: 'emitido',
          documentCode: null,
          title: row.titulo,
        }),
      );
    }

    const ncIds = Array.from(groupedIds.get('nonconformity') || []);
    if (ncIds.length > 0) {
      assignMany(
        'nonconformity',
        await this.nonConformitiesRepository.find({
          where: { id: In(ncIds) },
          select: ['id', 'company_id', 'site_id', 'status', 'codigo_nc'],
        }),
        (row) => ({
          companyId: row.company_id,
          siteId: row.site_id || null,
          status: row.status,
          documentCode: row.codigo_nc,
          title: `NC ${row.codigo_nc}`,
        }),
      );
    }

    return metadata;
  }

  private buildMetadataMapKey(module: string, documentId: string): string {
    return `${module}:${documentId}`;
  }

  private toDateOrNull(value: Date | string | null | undefined): Date | null {
    if (!value) {
      return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private toBoolean(value?: boolean | string | number | null): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value === 1;
    }
    if (typeof value === 'string') {
      return value === 't' || value === 'true' || value === '1';
    }
    return false;
  }

  private async mapWithConcurrency<T, R>(
    values: T[],
    limit: number,
    mapper: (value: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (values.length === 0) {
      return [];
    }

    const normalizedLimit = Math.max(1, Math.floor(limit));
    const results = new Array<R | undefined>(values.length);
    let nextIndex = 0;

    const workers = Array.from(
      { length: Math.min(normalizedLimit, values.length) },
      async () => {
        while (true) {
          const currentIndex = nextIndex++;
          if (currentIndex >= values.length) {
            return;
          }

          results[currentIndex] = await mapper(
            values[currentIndex],
            currentIndex,
          );
        }
      },
    );

    await Promise.all(workers);
    return results.filter((value): value is R => value !== undefined);
  }

  private async querySingleRow<TRow>(
    sql: string,
    params: unknown[],
  ): Promise<TRow | null> {
    const rows = (await this.snapshotRepository.query(sql, params)) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    return rows[0] as TRow;
  }
}
