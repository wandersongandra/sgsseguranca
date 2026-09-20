/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  CallHandler,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { Observable } from 'rxjs';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PdfRateLimitService } from '../auth/services/pdf-rate-limit.service';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { CacheService } from '../../shared/cache/cache.service';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { StorageService } from '../../shared/services/storage.service';
import { PdfService } from '../../shared/services/pdf.service';
import { RiskCalculationService } from '../../shared/services/risk-calculation.service';
import { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantService } from '../../shared/tenant/tenant.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { SignaturesController } from '../signatures/signatures.controller';
import { SignaturesService } from '../signatures/signatures.service';
import { Signature } from '../signatures/entities/signature.entity';
import { UsersService } from '../users/users.service';
import { AprExcelService } from './apr-excel.service';
import { AprRiskMatrixService } from './apr-risk-matrix.service';
import { AprsController } from './aprs.controller';
import { AprsService } from './aprs.service';
import { AprWorkflowService } from './aprs-workflow.service';
import { AprFeatureFlagGuard } from './guards/apr-feature-flag.guard';
import { AprsEvidenceService } from './services/aprs-evidence.service';
import { AprsPdfService } from './services/aprs-pdf.service';
import { AprWorkflowLockService } from './services/apr-workflow-lock.service';
import { AprMetricsService } from './services/apr-metrics.service';
import { Apr, AprStatus } from './entities/apr.entity';
import { AprLog } from './entities/apr-log.entity';
import { AprApprovalRecord } from './entities/apr-approval-record.entity';
import { AprRiskEvidence } from './entities/apr-risk-evidence.entity';
import { AprRiskItem } from './entities/apr-risk-item.entity';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import { User } from '../users/entities/user.entity';
import { NotificationsService } from '../notifications/notifications.service';

jest.setTimeout(15000);

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const ELABORADOR_ID = '33333333-3333-4333-8333-333333333333';
const PARTICIPANT_ID = '44444444-4444-4444-8444-444444444444';
const APPROVED_APR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PDF_LOCKED_APR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATTACHABLE_APR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPROVED_RISK_ITEM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PDF_LOCKED_RISK_ITEM_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ATTACHABLE_RISK_ITEM_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PDF_LOCKED_SIGNATURE_ID = '99999999-9999-4999-8999-999999999999';

type CurrentUser = {
  userId: string;
  id?: string;
  profile?: { nome?: string };
};

type Store = {
  aprs: Map<string, Apr>;
  aprLogs: Map<string, AprLog>;
  riskItems: Map<string, AprRiskItem>;
  evidences: Map<string, AprRiskEvidence>;
  signatures: Map<string, Signature>;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function buildUuid(counter: number): string {
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function operatorType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as { _type?: string; type?: string };
  return candidate._type || candidate.type;
}

function operatorValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as { _value?: unknown; value?: unknown };
  return candidate._value ?? candidate.value;
}

function matchesValue(current: unknown, expected: unknown): boolean {
  const type = operatorType(expected);

  if (type === 'isNull') {
    return current === null || current === undefined;
  }

  if (type === 'in') {
    const values = operatorValue(expected);
    return Array.isArray(values) && values.includes(current);
  }

  return current === expected;
}

function matchesWhere(
  record: Record<string, unknown>,
  where?: Record<string, unknown> | Array<Record<string, unknown>>,
): boolean {
  if (!where) {
    return true;
  }

  if (Array.isArray(where)) {
    return where.some((clause) =>
      Object.entries(clause).every(([key, value]) =>
        matchesValue(record[key], value),
      ),
    );
  }

  return Object.entries(where).every(([key, value]) =>
    matchesValue(record[key], value),
  );
}

function buildLegacyRiskRows() {
  return [
    {
      atividade_processo: 'Montagem de andaime',
      agente_ambiental: 'Ruído',
      condicao_perigosa: 'Trabalho em altura',
      fontes_circunstancias: 'Área externa',
      possiveis_lesoes: 'Queda',
      probabilidade: '2',
      severidade: '3',
      categoria_risco: 'Substancial',
      medidas_prevencao: 'Linha de vida',
      responsavel: 'Supervisor',
      prazo: '2026-03-22',
      status_acao: 'Pendente',
    },
  ];
}

function buildAprRiskItem(id: string, aprId: string): AprRiskItem {
  return {
    id,
    apr_id: aprId,
    atividade: 'Montagem de andaime',
    agente_ambiental: 'Ruído',
    condicao_perigosa: 'Trabalho em altura',
    fonte_circunstancia: 'Área externa',
    lesao: 'Queda',
    probabilidade: 2,
    severidade: 3,
    score_risco: 6,
    categoria_risco: 'Substancial',
    prioridade: 'Prioridade preferencial',
    medidas_prevencao: 'Linha de vida',
    epc: null,
    epi: null,
    permissao_trabalho: null,
    normas_relacionadas: null,
    hierarquia_controle: null,
    residual_probabilidade: null,
    residual_severidade: null,
    residual_score: null,
    residual_categoria: null,
    etapa: null,
    responsavel: 'Supervisor',
    prazo: new Date('2026-03-22T00:00:00.000Z'),
    status_acao: 'Pendente',
    ordem: 0,
    evidences: [],
    deleted_at: null,
    apr: null as unknown as import('./entities/apr.entity').Apr,
    created_at: new Date('2026-03-20T10:00:00.000Z'),
    updated_at: new Date('2026-03-20T10:00:00.000Z'),
  };
}

function buildApr(id: string, overrides: Partial<Apr> = {}): Apr {
  return {
    id,
    numero: `APR-${id.slice(0, 4).toUpperCase()}`,
    titulo: 'APR Torre',
    descricao: 'Análise preliminar de risco',
    data_inicio: new Date('2026-03-21T08:00:00.000Z'),
    data_fim: new Date('2026-03-21T18:00:00.000Z'),
    status: AprStatus.PENDENTE,
    is_modelo: false,
    is_modelo_padrao: false,
    itens_risco: buildLegacyRiskRows(),
    probability: 2,
    severity: 3,
    exposure: 1,
    initial_risk: 6,
    residual_risk: 'MEDIUM',
    evidence_photo: null,
    evidence_document: null,
    control_description: 'Linha de vida',
    control_evidence: false,
    company_id: COMPANY_ID,
    site_id: SITE_ID,
    elaborador_id: ELABORADOR_ID,
    auditado_por_id: null,
    data_auditoria: null,
    resultado_auditoria: null,
    notas_auditoria: null,
    pdf_file_key: null,
    pdf_folder_path: null,
    pdf_original_name: null,
    final_pdf_hash_sha256: null,
    verification_code: null,
    pdf_generated_at: null,
    versao: 1,
    parent_apr_id: null,
    aprovado_por_id: null,
    aprovado_em: null,
    aprovado_motivo: null,
    reprovado_por_id: null,
    reprovado_em: null,
    reprovado_motivo: null,
    classificacao_resumo: {
      total: 1,
      aceitavel: 0,
      atencao: 0,
      substancial: 1,
      critico: 0,
    },
    created_at: new Date('2026-03-20T10:00:00.000Z'),
    updated_at: new Date('2026-03-20T10:00:00.000Z'),
    deleted_at: null,
    activities: [],
    risks: [],
    epis: [],
    tools: [],
    machines: [],
    participants: [],
    risk_items: [],
    ...overrides,
  } as Apr;
}

function getErrorBody(body: unknown): { message?: string } {
  return body as { message?: string };
}

function getAprBody(body: unknown): {
  status?: string;
  parent_apr_id?: string | null;
  versao?: number;
  numero?: string;
} {
  return body as {
    status?: string;
    parent_apr_id?: string | null;
    versao?: number;
    numero?: string;
  };
}

describe('APR lock (http integration)', () => {
  let app: INestApplication;
  let currentUser: CurrentUser;
  let store: Store;
  let sequence = 1000;
  const manager: {
    transaction: <T>(
      callback: (transactionManager: typeof manager) => Promise<T> | T,
    ) => Promise<T>;
    getRepository: (entity: unknown) => Record<string, unknown>;
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
  } = {
    transaction: (callback) => Promise.resolve(callback(manager)),
    query: <T = unknown>(_sql: string, params?: unknown[]) => {
      const id = typeof params?.[0] === 'string' ? params[0] : undefined;
      const tenantId = typeof params?.[1] === 'string' ? params[1] : undefined;
      if (!id) {
        return Promise.resolve([]);
      }

      const apr = store.aprs.get(id);
      if (!apr) {
        return Promise.resolve([]);
      }
      if (tenantId && apr.company_id !== tenantId) {
        return Promise.resolve([]);
      }

      return Promise.resolve([clone(apr)] as Array<T>);
    },
    getRepository: (_entity: unknown) => ({
      exist: jest.fn(() => Promise.resolve(true)),
      count: jest.fn(() => Promise.resolve(0)),
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
      save: jest.fn((input: unknown) => Promise.resolve(input)),
      create: jest.fn((input: unknown) => input as Record<string, unknown>),
      update: jest.fn(() => Promise.resolve({ affected: 0 })),
      delete: jest.fn(() => Promise.resolve({ affected: 0 })),
    }),
  };

  const nextId = () => buildUuid(sequence++);

  const documentStorageService = {
    generateDocumentKey: jest.fn(
      (
        companyId: string,
        moduleName: string,
        entityId: string,
        originalName: string,
      ) => `documents/${companyId}/${moduleName}/${entityId}/${originalName}`,
    ),
    uploadFile: jest.fn(() => Promise.resolve()),
    deleteFile: jest.fn(() => Promise.resolve()),
    getSignedUrl: jest.fn((key: string) =>
      Promise.resolve(`https://signed.example/${encodeURIComponent(key)}`),
    ),
  };

  const pdfRateLimitService = {
    checkDownloadLimit: jest.fn(() => Promise.resolve()),
  };

  const tenantService = {
    getTenantId: jest.fn(() => COMPANY_ID),
    isSuperAdmin: jest.fn(() => false),
    getContext: jest.fn(() => ({
      companyId: COMPANY_ID,
      siteScope: 'all',
      isSuperAdmin: false,
    })),
  };

  const riskCalculationService = {
    calculateScore: jest.fn(
      (prob?: number | null, sev?: number | null) =>
        Number(prob || 0) * Number(sev || 0),
    ),
    classifyByScore: jest.fn((score: number) => {
      if (score <= 2) return 'LOW';
      if (score <= 4) return 'MEDIUM';
      if (score <= 6) return 'HIGH';
      return 'CRITICAL';
    }),
    suggestControls: jest.fn(() => []),
  };

  const aprRiskMatrixService = {
    evaluate: jest.fn((prob?: number | null, sev?: number | null) => {
      if (!prob || !sev) {
        return { score: null, categoria: null, prioridade: null };
      }

      const score = Number(prob) * Number(sev);
      if (score <= 2) {
        return {
          score,
          categoria: 'Aceitável',
          prioridade: 'Não prioritário',
        };
      }
      if (score <= 4) {
        return {
          score,
          categoria: 'Atenção',
          prioridade: 'Prioridade básica',
        };
      }
      if (score <= 6) {
        return {
          score,
          categoria: 'Substancial',
          prioridade: 'Prioridade preferencial',
        };
      }
      return {
        score,
        categoria: 'Crítico',
        prioridade: 'Prioridade máxima',
      };
    }),
    normalizeCategory: jest.fn((value?: string | null) => value || null),
    summarize: jest.fn((categories: Array<string | null | undefined>) => ({
      total: categories.filter(Boolean).length,
      aceitavel: categories.filter((value) => value === 'Aceitável').length,
      atencao: categories.filter((value) => value === 'Atenção').length,
      substancial: categories.filter((value) => value === 'Substancial').length,
      critico: categories.filter((value) => value === 'Crítico').length,
    })),
  };

  const aprExcelService = {
    previewImport: jest.fn(),
    buildTemplateWorkbook: jest.fn(() => Buffer.from('template')),
    buildDetailWorkbook: jest.fn(() => Buffer.from('detail')),
  };
  const pdfService = {
    generateFromHtml: jest.fn(() => Promise.resolve(Buffer.from('%PDF-1.4'))),
  };

  const forensicTrailService = {
    append: jest.fn(() => Promise.resolve(undefined)),
  };

  const signatureTimestampService = {
    issueFromHash: jest.fn(() => ({
      signature_hash: 'server-hash',
      timestamp_token: 'tsa-token',
      timestamp_authority: 'tsa',
      timestamp_issued_at: '2026-03-21T12:00:00.000Z',
    })),
    verify: jest.fn(() => true),
  };

  const usersService = {
    deriveHmacKey: jest.fn(() => Promise.resolve('derived-key')),
    computeHmac: jest.fn(() => 'computed-hmac'),
  };

  const allowGuard = {
    canActivate: jest.fn((context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest<{ user?: CurrentUser }>();
      req.user = currentUser;
      return true;
    }),
  };

  const passthroughInterceptor = {
    intercept: (
      _context: ExecutionContext,
      next: CallHandler,
    ): Observable<unknown> => next.handle(),
  };

  const saveApr = (input: Partial<Apr>): Apr => {
    const id = input.id || nextId();
    const existing = store.aprs.get(id);
    const record = buildApr(id, {
      ...(existing ? clone(existing) : {}),
      ...input,
      id,
      updated_at: new Date('2026-03-21T12:00:00.000Z'),
    });
    store.aprs.set(id, clone(record));
    return clone(record);
  };

  const saveRiskItem = (input: Partial<AprRiskItem>): AprRiskItem => {
    const id = input.id || nextId();
    const existing = store.riskItems.get(id);
    const record = {
      ...(existing
        ? clone(existing)
        : buildAprRiskItem(id, input.apr_id || '')),
      ...input,
      id,
      created_at: existing?.created_at || new Date('2026-03-20T10:00:00.000Z'),
      updated_at: new Date('2026-03-21T12:00:00.000Z'),
      evidences: Array.isArray(input.evidences)
        ? input.evidences
        : existing?.evidences || [],
    };
    store.riskItems.set(id, clone(record));
    return clone(record);
  };

  const saveAprLog = (input: Partial<AprLog>): AprLog => {
    const record = {
      id: input.id || nextId(),
      apr_id: input.apr_id as string,
      usuario_id: input.usuario_id ?? null,
      acao: input.acao as string,
      metadata: input.metadata ?? null,
      data_hora: input.data_hora || new Date('2026-03-21T12:00:00.000Z'),
    } as AprLog;
    store.aprLogs.set(record.id, clone(record));
    return clone(record);
  };

  const saveSignature = (input: Partial<Signature>): Signature => {
    const record = {
      id: input.id || nextId(),
      user_id: input.user_id || currentUser.userId,
      document_id: input.document_id || APPROVED_APR_ID,
      document_type: input.document_type || 'APR',
      signature_data: input.signature_data || 'data:image/png;base64,AAAA',
      type: input.type || 'digital',
      company_id: input.company_id ?? COMPANY_ID,
      signature_hash: input.signature_hash ?? null,
      timestamp_token: input.timestamp_token ?? null,
      timestamp_authority: input.timestamp_authority ?? null,
      signed_at: input.signed_at || new Date('2026-03-21T12:00:00.000Z'),
      integrity_payload: input.integrity_payload ?? null,
      created_at: input.created_at || new Date('2026-03-21T12:00:00.000Z'),
    } as Signature;
    store.signatures.set(record.id, clone(record));
    return clone(record);
  };

  const aprLogsRepository = {
    create: jest.fn((input: Partial<AprLog>) => ({
      ...input,
      id: nextId(),
      data_hora: new Date('2026-03-21T12:00:00.000Z'),
    })),
    save: jest.fn((input: AprLog) => Promise.resolve(saveAprLog(input))),
    find: jest.fn((options?: { where?: Record<string, unknown> }) =>
      Promise.resolve(
        [...store.aprLogs.values()]
          .filter((record) =>
            matchesWhere(
              record as unknown as Record<string, unknown>,
              options?.where,
            ),
          )
          .map((record) => clone(record)),
      ),
    ),
  };

  const aprRiskItemsRepository = {
    create: jest.fn((input: Partial<AprRiskItem>) =>
      saveRiskItem({
        ...input,
        id: input.id || nextId(),
      }),
    ),
    find: jest.fn((options?: { where?: Record<string, unknown> }) =>
      Promise.resolve(
        [...store.riskItems.values()]
          .filter((record) =>
            matchesWhere(
              record as unknown as Record<string, unknown>,
              options?.where,
            ),
          )
          .sort((left, right) => left.ordem - right.ordem)
          .map((record) => ({
            ...clone(record),
            evidences: [...store.evidences.values()].filter(
              (evidence) => evidence.apr_risk_item_id === record.id,
            ),
          })),
      ),
    ),
    findOne: jest.fn((options?: { where?: Record<string, unknown> }) =>
      Promise.resolve(
        [...store.riskItems.values()].find((record) =>
          matchesWhere(
            record as unknown as Record<string, unknown>,
            options?.where,
          ),
        ) || null,
      ),
    ),
    save: jest.fn((input: AprRiskItem | AprRiskItem[]) => {
      if (Array.isArray(input)) {
        return Promise.resolve(input.map((item) => saveRiskItem(item)));
      }
      return Promise.resolve(saveRiskItem(input));
    }),
    delete: jest.fn((criteria: unknown) => {
      const ids = Array.isArray(criteria) ? (criteria as string[]) : [];
      ids.forEach((id) => store.riskItems.delete(id));
      return Promise.resolve({ affected: ids.length });
    }),
  };

  const aprEvidencesRepository = {
    create: jest.fn((input: Partial<AprRiskEvidence>) => ({
      ...input,
      id: nextId(),
      uploaded_at: new Date('2026-03-21T12:00:00.000Z'),
    })),
    save: jest.fn((input: AprRiskEvidence) =>
      Promise.resolve({
        ...input,
        id: input.id || nextId(),
      }),
    ),
    find: jest.fn(() => Promise.resolve([])),
  };

  const signaturesRepository = {
    create: jest.fn((input: Partial<Signature>) => ({
      ...input,
      id: input.id || nextId(),
      created_at: new Date('2026-03-21T12:00:00.000Z'),
    })),
    save: jest.fn((input: Signature) => Promise.resolve(saveSignature(input))),
    find: jest.fn(
      (options?: {
        where?: Record<string, unknown> | Array<Record<string, unknown>>;
      }) =>
        Promise.resolve(
          [...store.signatures.values()]
            .filter((record) =>
              matchesWhere(
                record as unknown as Record<string, unknown>,
                options?.where,
              ),
            )
            .map((record) => clone(record)),
        ),
    ),
    findOne: jest.fn(
      (options?: {
        where?: Record<string, unknown> | Array<Record<string, unknown>>;
      }) =>
        Promise.resolve(
          [...store.signatures.values()].find((record) =>
            matchesWhere(
              record as unknown as Record<string, unknown>,
              options?.where,
            ),
          ) || null,
        ),
    ),
    delete: jest.fn((criteria: unknown) => {
      let affected = 0;
      if (criteria && typeof criteria === 'object') {
        [...store.signatures.values()].forEach((record) => {
          if (
            matchesWhere(
              record as unknown as Record<string, unknown>,
              criteria as Record<string, unknown>,
            )
          ) {
            store.signatures.delete(record.id);
            affected += 1;
          }
        });
      }
      return Promise.resolve({ affected });
    }),
    manager: {
      transaction: jest.fn((callback: (tx: typeof manager) => unknown) =>
        Promise.resolve(callback(manager)),
      ),
    },
  };

  const aprsRepository = {
    create: jest.fn((input: Partial<Apr>) =>
      buildApr(input.id || nextId(), input),
    ),
    findOne: jest.fn((options?: { where?: Record<string, unknown> }) => {
      const record = [...store.aprs.values()].find((candidate) =>
        matchesWhere(
          candidate as unknown as Record<string, unknown>,
          options?.where,
        ),
      );

      if (!record || record.deleted_at) {
        return Promise.resolve(null);
      }

      return Promise.resolve(
        clone({
          ...record,
          risk_items: [...store.riskItems.values()]
            .filter((item) => item.apr_id === record.id)
            .sort((left, right) => left.ordem - right.ordem)
            .map((item) => clone(item)),
        }),
      );
    }),
    save: jest.fn((input: Apr) => Promise.resolve(saveApr(input))),
    update: jest.fn(
      (criteria: string | Record<string, unknown>, partial: Partial<Apr>) => {
        let affected = 0;
        [...store.aprs.values()].forEach((record) => {
          const matched =
            typeof criteria === 'string'
              ? record.id === criteria
              : matchesWhere(
                  record as unknown as Record<string, unknown>,
                  criteria,
                );
          if (!matched) {
            return;
          }
          saveApr({ ...record, ...partial, id: record.id });
          affected += 1;
        });
        return Promise.resolve({ affected });
      },
    ),
    softDelete: jest.fn((id: string) => {
      const record = store.aprs.get(id);
      if (!record) {
        return Promise.resolve({ affected: 0 });
      }
      saveApr({ ...record, deleted_at: new Date('2026-03-21T12:00:00.000Z') });
      return Promise.resolve({ affected: 1 });
    }),
    count: jest.fn(() => Promise.resolve(0)),
    manager: null as unknown,
    createQueryBuilder: jest.fn(() => {
      let rootId: string | undefined;
      const builder: {
        select: jest.Mock;
        where: jest.Mock;
        getRawOne: jest.Mock;
      } = {
        select: jest.fn(),
        where: jest.fn(),
        getRawOne: jest.fn(() => {
          const versions = [...store.aprs.values()]
            .filter(
              (record) =>
                record.id === rootId || record.parent_apr_id === rootId,
            )
            .map((record) => record.versao ?? 1);
          const max = versions.length > 0 ? Math.max(...versions) : 1;
          return Promise.resolve({ max: String(max) });
        }),
      };
      builder.select.mockImplementation(() => builder);
      builder.where.mockImplementation(
        (
          _query: string,
          params?: {
            rootId?: string;
          },
        ) => {
          rootId = params?.rootId;
          return builder;
        },
      );
      return builder;
    }),
  };

  manager.getRepository = (entity: unknown) => {
    if (entity === Apr) return aprsRepository;
    if (entity === AprRiskItem) {
      return aprRiskItemsRepository;
    }
    if (entity === AprRiskEvidence) {
      return aprEvidencesRepository;
    }
    if (entity === Signature) {
      return signaturesRepository;
    }
    return {
      exist: jest.fn(() => Promise.resolve(true)),
      count: jest.fn(() => Promise.resolve(0)),
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
      save: jest.fn((input: unknown) => Promise.resolve(input)),
      create: jest.fn((input: unknown) => input as Record<string, unknown>),
      update: jest.fn(() => Promise.resolve({ affected: 0 })),
      delete: jest.fn(() => Promise.resolve({ affected: 0 })),
    };
  };

  aprsRepository.manager = manager;

  const documentGovernanceService = {
    registerFinalDocument: jest.fn(
      async (input: {
        persistEntityMetadata: (
          tx: typeof manager,
          fileHash: string,
        ) => Promise<void>;
      }) => {
        await input.persistEntityMetadata(manager, 'hash-1');
        return { hash: 'hash-1', registryEntry: { id: 'registry-1' } };
      },
    ),
    removeFinalDocumentReference: jest.fn(
      async (input: {
        removeEntityState: (tx: typeof manager) => Promise<void>;
      }) => {
        await input.removeEntityState(manager);
      },
    ),
    findRegistryContextForSignature: jest.fn(() => Promise.resolve(null)),
  };

  const dataSource = {
    query: jest.fn().mockResolvedValue([{ count: '0' }]),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === Apr) {
        return { findOne: aprsRepository.findOne };
      }
      return { findOne: jest.fn(() => Promise.resolve(null)) };
    }),
  };

  const seedStore = () => {
    store.aprs.clear();
    store.aprLogs.clear();
    store.riskItems.clear();
    store.evidences.clear();
    store.signatures.clear();
    sequence = 1000;

    const approvedApr = buildApr(APPROVED_APR_ID, {
      numero: 'APR-APPROVED',
      status: AprStatus.APROVADA,
      participants: [{ id: PARTICIPANT_ID }] as never[],
    });
    const pdfLockedApr = buildApr(PDF_LOCKED_APR_ID, {
      numero: 'APR-LOCKED',
      status: AprStatus.APROVADA,
      pdf_file_key: 'documents/company-1/aprs/locked/apr-final.pdf',
      pdf_folder_path: 'aprs/company-1',
      pdf_original_name: 'apr-final.pdf',
      final_pdf_hash_sha256: 'a'.repeat(64),
      verification_code: 'APR-LOCKED',
      pdf_generated_at: new Date('2026-03-21T19:00:00.000Z'),
      participants: [{ id: PARTICIPANT_ID }] as never[],
    });
    const attachableApr = buildApr(ATTACHABLE_APR_ID, {
      numero: 'APR-ATTACHABLE',
      status: AprStatus.APROVADA,
      participants: [{ id: PARTICIPANT_ID }] as never[],
    });

    store.aprs.set(approvedApr.id, clone(approvedApr));
    store.aprs.set(pdfLockedApr.id, clone(pdfLockedApr));
    store.aprs.set(attachableApr.id, clone(attachableApr));

    store.riskItems.set(
      APPROVED_RISK_ITEM_ID,
      buildAprRiskItem(APPROVED_RISK_ITEM_ID, APPROVED_APR_ID),
    );
    store.riskItems.set(
      PDF_LOCKED_RISK_ITEM_ID,
      buildAprRiskItem(PDF_LOCKED_RISK_ITEM_ID, PDF_LOCKED_APR_ID),
    );
    store.riskItems.set(
      ATTACHABLE_RISK_ITEM_ID,
      buildAprRiskItem(ATTACHABLE_RISK_ITEM_ID, ATTACHABLE_APR_ID),
    );

    saveSignature({
      id: PDF_LOCKED_SIGNATURE_ID,
      document_id: PDF_LOCKED_APR_ID,
      document_type: 'APR',
      user_id: currentUser.userId,
      company_id: COMPANY_ID,
    });
    saveSignature({
      document_id: ATTACHABLE_APR_ID,
      document_type: 'APR',
      user_id: PARTICIPANT_ID,
      company_id: COMPANY_ID,
    });
  };

  const getHttpServer = () =>
    app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    currentUser = {
      userId: ELABORADOR_ID,
      id: ELABORADOR_ID,
      profile: { nome: 'administrador da empresa' },
    };
    store = {
      aprs: new Map<string, Apr>(),
      aprLogs: new Map<string, AprLog>(),
      riskItems: new Map<string, AprRiskItem>(),
      evidences: new Map<string, AprRiskEvidence>(),
      signatures: new Map<string, Signature>(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AprsController, SignaturesController],
      providers: [
        AprsService,
        AprWorkflowService,
        AprsPdfService,
        AprsEvidenceService,
        SignaturesService,
        { provide: AprMetricsService, useValue: { record: jest.fn() } },
        { provide: getRepositoryToken(Apr), useValue: aprsRepository },
        { provide: getRepositoryToken(AprLog), useValue: aprLogsRepository },
        {
          provide: getRepositoryToken(AprApprovalRecord),
          useValue: {
            create: jest.fn((input) => input),
            save: jest.fn((input) => Promise.resolve(input)),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([]),
            }),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: getRepositoryToken(Signature),
          useValue: signaturesRepository,
        },
        { provide: TenantService, useValue: tenantService },
        { provide: RiskCalculationService, useValue: riskCalculationService },
        { provide: AprRiskMatrixService, useValue: aprRiskMatrixService },
        { provide: AprExcelService, useValue: aprExcelService },
        {
          provide: StorageService,
          useValue: { uploadFile: jest.fn(), deleteFile: jest.fn() },
        },
        { provide: DocumentStorageService, useValue: documentStorageService },
        { provide: PdfService, useValue: pdfService },
        {
          provide: DocumentGovernanceService,
          useValue: documentGovernanceService,
        },
        {
          provide: DocumentBundleService,
          useValue: { buildWeeklyPdfBundle: jest.fn() },
        },
        {
          provide: CacheService,
          useValue: { getOrSet: jest.fn(), del: jest.fn() },
        },
        { provide: PdfRateLimitService, useValue: pdfRateLimitService },
        {
          provide: FileInspectionService,
          useValue: { inspect: jest.fn().mockResolvedValue({ safe: true }) },
        },
        { provide: ForensicTrailService, useValue: forensicTrailService },
        {
          provide: SignatureTimestampService,
          useValue: signatureTimestampService,
        },
        { provide: UsersService, useValue: usersService },
        {
          provide: PublicValidationGrantService,
          useValue: {
            issueToken: jest.fn().mockResolvedValue('token-publico'),
          },
        },
        {
          provide: AprWorkflowLockService,
          useValue: {
            runExclusive: jest.fn(
              (
                _id: string,
                operation: (assertHealthy: () => void) => Promise<unknown>,
              ) => operation(() => {}),
            ),
          },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allowGuard)
      .overrideGuard(TenantGuard)
      .useValue(allowGuard)
      .overrideGuard(RolesGuard)
      .useValue(allowGuard)
      .overrideGuard(PermissionsGuard)
      .useValue(allowGuard)
      .overrideGuard(AprFeatureFlagGuard)
      .useValue(allowGuard)
      .overrideInterceptor(TenantInterceptor)
      .useValue(passthroughInterceptor)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentUser = {
      userId: ELABORADOR_ID,
      id: ELABORADOR_ID,
      profile: { nome: 'administrador da empresa' },
    };
    tenantService.getTenantId.mockReturnValue(COMPANY_ID);
    seedStore();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('bloqueia update comum e preserva o estado da APR aprovada', async () => {
    const response = await request(getHttpServer())
      .patch(`/aprs/${APPROVED_APR_ID}`)
      .send({ titulo: 'APR alterada fora do fluxo' })
      .expect(400);

    const body = getErrorBody(response.body);
    expect(body.message).toBe(
      'Somente APRs pendentes podem ser editadas pelo formulário. Use os fluxos formais de aprovação, cancelamento, encerramento ou nova versão.',
    );
    expect(store.aprs.get(APPROVED_APR_ID)?.titulo).toBe('APR Torre');
  });

  it('bloqueia evidência lateral para APR aprovada e não persiste artefato', async () => {
    const response = await request(getHttpServer())
      .post(
        `/aprs/${APPROVED_APR_ID}/risk-items/${APPROVED_RISK_ITEM_ID}/evidence`,
      )
      .field('captured_at', '2026-03-21T10:00:00.000Z')
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]), {
        filename: 'evidence.jpg',
        contentType: 'image/jpeg',
      })
      .expect(400);

    const body = getErrorBody(response.body);
    expect(body.message).toBe(
      'Somente APRs pendentes podem ser editadas pelo formulário. Use os fluxos formais de aprovação, cancelamento, encerramento ou nova versão.',
    );
    expect(store.evidences.size).toBe(0);
    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('bloqueia criação de assinatura para APR aprovada e mantém a trilha intacta', async () => {
    const initialSignatureCount = store.signatures.size;

    const response = await request(getHttpServer())
      .post('/signatures')
      .send({
        document_id: APPROVED_APR_ID,
        document_type: 'APR',
        signature_data: 'data:image/png;base64,AAAA',
        type: 'digital',
      })
      .expect(400);

    const body = getErrorBody(response.body);
    expect(body.message).toBe(
      'Somente APRs pendentes podem ter assinaturas alteradas diretamente. Use nova versão se precisar ajustar signatários.',
    );
    expect(store.signatures.size).toBe(initialSignatureCount);
  });

  it('bloqueia remoção de APR aprovada fora do fluxo formal', async () => {
    const response = await request(getHttpServer())
      .delete(`/aprs/${APPROVED_APR_ID}`)
      .expect(400);

    const body = getErrorBody(response.body);
    expect(body.message).toBe(
      'Somente APRs pendentes e sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros fechados.',
    );
    expect(store.aprs.get(APPROVED_APR_ID)?.deleted_at).toBeNull();
  });

  it('bloqueia update comum quando a APR já tem PDF final emitido', async () => {
    const response = await request(getHttpServer())
      .patch(`/aprs/${PDF_LOCKED_APR_ID}`)
      .send({ titulo: 'APR travada alterada' })
      .expect(400);

    const body = getErrorBody(response.body);
    expect(body.message).toBe(
      'APR assinada anexada. Edição bloqueada. Crie uma nova versão para alterar.',
    );
    expect(store.aprs.get(PDF_LOCKED_APR_ID)?.pdf_file_key).toContain(
      'apr-final.pdf',
    );
  });

  it('mantém finalize como fluxo formal mesmo quando a APR já possui PDF final', async () => {
    // Usa a rota canônica PATCH (o alias legado POST foi descontinuado/sunset).
    await request(getHttpServer())
      .patch(`/aprs/${PDF_LOCKED_APR_ID}/finalize`)
      .expect(200);

    expect(store.aprs.get(PDF_LOCKED_APR_ID)?.status).toBe(AprStatus.ENCERRADA);
  });

  it('bloqueia mutação lateral de assinatura quando a APR já está fechada com PDF final', async () => {
    const initialSignatureCount = store.signatures.size;

    const response = await request(getHttpServer())
      .delete(`/signatures/document/${PDF_LOCKED_APR_ID}`)
      .query({ document_type: 'APR' })
      .expect(400);

    const body = getErrorBody(response.body);
    expect(body.message).toBe(
      'APR com PDF final emitido está bloqueada para alterações de assinatura. Gere uma nova versão para seguir com alterações.',
    );
    expect(store.signatures.size).toBe(initialSignatureCount);
  });

  it('bloqueia attachPdf manual para APR aprovada ainda sem PDF final', async () => {
    const response = await request(getHttpServer())
      .post(`/aprs/${ATTACHABLE_APR_ID}/file`)
      .attach('file', Buffer.from('%PDF-1.4 apr attach test'), {
        filename: 'apr-final.pdf',
        contentType: 'application/pdf',
      })
      .expect(410);

    const body = getErrorBody(response.body);
    expect(body.message).toContain(
      'O anexo manual de PDF final da APR foi descontinuado',
    );
    expect(store.aprs.get(ATTACHABLE_APR_ID)?.pdf_file_key).toBeNull();
    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('mantém createNewVersion como caminho oficial mesmo após o fechamento com PDF final', async () => {
    const response = await request(getHttpServer())
      .post(`/aprs/${PDF_LOCKED_APR_ID}/new-version`)
      .expect(201);

    const body = getAprBody(response.body);
    expect(body.status).toBe(AprStatus.PENDENTE);
    expect(body.parent_apr_id).toBe(PDF_LOCKED_APR_ID);
    expect(body.versao).toBe(2);
    expect(body.numero).toBe('APR-LOCKED-v2');

    const createdApr = [...store.aprs.values()].find(
      (record) => record.parent_apr_id === PDF_LOCKED_APR_ID,
    );
    expect(createdApr).toBeDefined();
    expect(createdApr?.status).toBe(AprStatus.PENDENTE);
    expect(
      [...store.riskItems.values()].some(
        (item) => item.apr_id === createdApr?.id,
      ),
    ).toBe(true);
  });
});
