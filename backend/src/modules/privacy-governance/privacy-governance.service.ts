import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import {
  PRIVACY_SUBPROCESSORS,
  PrivacySubprocessor,
} from './subprocessors.registry';
import {
  PRIVACY_RETENTION_MATRIX,
  PrivacyRetentionMatrixEntry,
} from './retention-matrix.registry';
import {
  TENANT_OFFBOARDING_CHECKLIST,
  TenantOffboardingStep,
} from './offboarding-checklist.registry';

export type SubprocessorRegistryResponse = {
  generatedAt: string;
  caveat: string;
  subprocessors: PrivacySubprocessor[];
};

export type RetentionMatrixResponse = {
  generatedAt: string;
  caveat: string;
  entries: PrivacyRetentionMatrixEntry[];
};

export type TenantOffboardingChecklistResponse = {
  generatedAt: string;
  caveat: string;
  steps: TenantOffboardingStep[];
};

type DocumentRegistryManifestRow = {
  id: string;
  module: string;
  document_type: string;
  entity_id: string;
  title: string;
  file_key: string;
  original_name: string | null;
  mime_type: string | null;
  file_hash: string | null;
  status: string;
  litigation_hold: boolean;
  expires_at: Date | string | null;
  created_at: Date | string;
};

type DocumentRegistryModuleCountRow = {
  module: string;
  total: string | number;
};

export type TenantStorageManifestEntry = {
  source: 'document_registry';
  id: string;
  module: string;
  documentType: string;
  entityId: string;
  title: string;
  fileKey: string;
  originalName: string | null;
  mimeType: string | null;
  fileHash: string | null;
  status: string;
  litigationHold: boolean;
  expiresAt: string | null;
  createdAt: string;
};

export type TenantStorageManifestResponse = {
  generatedAt: string;
  companyId: string;
  database: {
    totalKnownObjects: number;
    byModule: Array<{ module: string; total: number }>;
    entries: TenantStorageManifestEntry[];
    truncated: boolean;
    limit: number;
  };
  storage: {
    listingRequested: boolean;
    listedPrefixes: string[];
    keys: string[];
    truncated: boolean;
    error: string | null;
  };
  caveat: string;
};

export type TenantStorageExpungePlanResponse = {
  generatedAt: string;
  companyId: string;
  dryRun: true;
  eligibleCount: number;
  blockedCount: number;
  eligibleKeys: TenantStorageManifestEntry[];
  blocked: Array<{
    entry: TenantStorageManifestEntry;
    reason: string;
  }>;
  caveat: string;
};

@Injectable()
export class PrivacyGovernanceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly documentStorageService: DocumentStorageService,
  ) {}

  getSubprocessors(): SubprocessorRegistryResponse {
    return {
      generatedAt: new Date().toISOString(),
      caveat:
        'Registro tecnico para governanca LGPD. Status pending_review exige evidencia contratual antes de declarar conformidade documental.',
      subprocessors: PRIVACY_SUBPROCESSORS,
    };
  }

  getRetentionMatrix(): RetentionMatrixResponse {
    return {
      generatedAt: new Date().toISOString(),
      caveat:
        'Matriz tecnica de retenção. Itens requires_external_evidence não devem ser tratados como comprovadamente executados sem evidencia de contrato, storage ou backup.',
      entries: PRIVACY_RETENTION_MATRIX,
    };
  }

  getTenantOffboardingChecklist(): TenantOffboardingChecklistResponse {
    return {
      generatedAt: new Date().toISOString(),
      caveat:
        'Checklist operacional de desligamento de tenant. Passos bloqueantes exigem evidência antes do encerramento contratual.',
      steps: TENANT_OFFBOARDING_CHECKLIST,
    };
  }

  private toIso(value: Date | string | null): string | null {
    if (value === null) return null;
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? String(value)
      : parsed.toISOString();
  }

  private toInt(value: string | number): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  async getTenantStorageManifest(
    companyId: string,
    options: {
      includeStorageListing?: boolean;
      limit?: number;
    } = {},
  ): Promise<TenantStorageManifestResponse> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 2000);
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<DocumentRegistryManifestRow[]>(
        `
          SELECT
            id,
            module,
            document_type,
            entity_id,
            title,
            file_key,
            original_name,
            mime_type,
            file_hash,
            status,
            litigation_hold,
            expires_at,
            created_at
          FROM document_registry
          WHERE company_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [companyId, limit + 1],
      ),
      this.dataSource.query<DocumentRegistryModuleCountRow[]>(
        `
          SELECT module, COUNT(*) AS total
          FROM document_registry
          WHERE company_id = $1
          GROUP BY module
          ORDER BY module ASC
        `,
        [companyId],
      ),
    ]);

    const truncated = rows.length > limit;
    const entries = rows.slice(0, limit).map((row) => ({
      source: 'document_registry' as const,
      id: row.id,
      module: row.module,
      documentType: row.document_type,
      entityId: row.entity_id,
      title: row.title,
      fileKey: row.file_key,
      originalName: row.original_name,
      mimeType: row.mime_type,
      fileHash: row.file_hash,
      status: row.status,
      litigationHold: row.litigation_hold,
      expiresAt: this.toIso(row.expires_at),
      createdAt: this.toIso(row.created_at) ?? String(row.created_at),
    }));

    const storage = {
      listingRequested: options.includeStorageListing === true,
      listedPrefixes: [] as string[],
      keys: [] as string[],
      truncated: false,
      error: null as string | null,
    };

    if (options.includeStorageListing) {
      const prefixes = [
        `documents/${companyId}/`,
        `quarantine/${companyId}/`,
        `reports/${companyId}/`,
      ];
      storage.listedPrefixes = prefixes;
      try {
        const keys = (
          await Promise.all(
            prefixes.map((prefix) =>
              this.documentStorageService.listKeys(
                this.documentStorageService.createPrefixReference({
                  tenantId: companyId,
                  prefix,
                  owner: { resourceType: 'company', resourceId: companyId },
                  purpose: 'privacy-tenant-storage-manifest',
                  legacy: prefix.startsWith('reports/'),
                }),
                { maxKeys: 500 },
              ),
            ),
          )
        ).flat();
        storage.keys = keys.slice(0, 500);
        storage.truncated = keys.length > storage.keys.length;
      } catch (error) {
        storage.error = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      companyId,
      database: {
        totalKnownObjects: countRows.reduce(
          (sum, row) => sum + this.toInt(row.total),
          0,
        ),
        byModule: countRows.map((row) => ({
          module: row.module,
          total: this.toInt(row.total),
        })),
        entries,
        truncated,
        limit,
      },
      storage,
      caveat:
        'Manifesto operacional para offboarding. A seção database lista objetos conhecidos no document_registry; storage lista apenas prefixos padronizados quando solicitado e depende das credenciais do provedor.',
    };
  }

  async getTenantStorageExpungePlan(
    companyId: string,
    options: { limit?: number } = {},
  ): Promise<TenantStorageExpungePlanResponse> {
    const manifest = await this.getTenantStorageManifest(companyId, {
      limit: options.limit,
    });
    const now = Date.now();
    const eligibleKeys: TenantStorageManifestEntry[] = [];
    const blocked: TenantStorageExpungePlanResponse['blocked'] = [];

    for (const entry of manifest.database.entries) {
      if (entry.litigationHold) {
        blocked.push({ entry, reason: 'legal_hold' });
        continue;
      }

      if (entry.status !== 'EXPIRED') {
        blocked.push({ entry, reason: 'status_not_expired' });
        continue;
      }

      if (!entry.expiresAt) {
        blocked.push({ entry, reason: 'missing_expiry_date' });
        continue;
      }

      const expiresAt = new Date(entry.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt > now) {
        blocked.push({ entry, reason: 'retention_not_elapsed' });
        continue;
      }

      eligibleKeys.push(entry);
    }

    return {
      generatedAt: new Date().toISOString(),
      companyId,
      dryRun: true,
      eligibleCount: eligibleKeys.length,
      blockedCount: blocked.length,
      eligibleKeys,
      blocked,
      caveat:
        'Plano dry-run: nenhuma exclusão é executada. Expurgo físico exige etapa separada com confirmação explícita, auditoria e validação de legal hold.',
    };
  }
}
