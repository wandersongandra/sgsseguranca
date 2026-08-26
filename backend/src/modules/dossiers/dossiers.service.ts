import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { storageKeyFingerprint } from '../../shared/storage/storage-compensation.util';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import JSZip from 'jszip';
import { In, Repository } from 'typeorm';
import { Apr } from '../aprs/entities/apr.entity';
import { Audit } from '../audits/entities/audit.entity';
import { Cat } from '../cats/entities/cat.entity';
import { Checklist } from '../checklists/entities/checklist.entity';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { Dds } from '../dds/entities/dds.entity';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentRegistryService } from '../document-registry/document-registry.service';
import { EpiAssignment } from '../epi-assignments/entities/epi-assignment.entity';
import { NonConformity } from '../nonconformities/entities/nonconformity.entity';
import { Pt } from '../pts/entities/pt.entity';
import { Rdo } from '../rdos/entities/rdo.entity';
import { Site } from '../sites/entities/site.entity';
import { Training } from '../trainings/entities/training.entity';
import { User } from '../users/entities/user.entity';
import {
  applyBackendPdfFooter,
  backendPdfTheme,
  createBackendPdfTableTheme,
  drawBackendPdfHeader,
  drawBackendSectionTitle,
  getBackendLastTableY,
} from '../../shared/services/pdf-branding';

interface DossierAttachmentLine {
  tipo: string;
  referencia: string;
  arquivo: string;
  url: string;
}

type GovernedDossierModule =
  | 'apr'
  | 'pt'
  | 'dds'
  | 'rdo'
  | 'checklist'
  | 'cat'
  | 'audit'
  | 'nonconformity';

interface DossierGovernedDocumentLine {
  modulo: GovernedDossierModule;
  modulo_label: string;
  referencia: string;
  codigo_documento: string | null;
  arquivo: string;
  disponibilidade: 'ready' | 'registered_without_signed_url';
  emitido_em: string | null;
}

interface DossierPendingGovernedDocumentLine {
  modulo: GovernedDossierModule;
  modulo_label: string;
  referencia: string;
  status_atual: string | null;
  pendencia: string;
}

interface DossierGovernedArtifact {
  modulo: GovernedDossierModule;
  modulo_label: string;
  entityId: string;
  referencia: string;
  codigo_documento: string | null;
  arquivo: string;
  disponibilidade: 'ready' | 'registered_without_signed_url';
  emitido_em: string | null;
  fileKey: string;
  fileHash: string | null;
}

type DossierInclusionPolicy = {
  officialDocuments: string;
  pendingOfficialDocuments: string;
  supportingAttachments: string;
  zipBundle: string;
  notes: string[];
};

interface EmployeeDossierPdfData {
  user: User;
  trainings: Training[];
  assignments: EpiAssignment[];
  attachmentLines: DossierAttachmentLine[];
  governedDocumentLines: DossierGovernedDocumentLine[];
  pendingGovernedDocumentLines: DossierPendingGovernedDocumentLine[];
  logoBase64?: string | null;
  logoFormat?: 'PNG' | 'JPEG';
}

interface EmployeeDossierBundle {
  user: User;
  trainings: Training[];
  assignments: EpiAssignment[];
  pts: Pt[];
  cats: Cat[];
  attachmentLines: DossierAttachmentLine[];
  governedDocumentLines: DossierGovernedDocumentLine[];
  pendingGovernedDocumentLines: DossierPendingGovernedDocumentLine[];
  governedArtifacts: DossierGovernedArtifact[];
  truncation: DossierTruncationInfo;
}

interface SiteDossierBundle {
  site: Site;
  users: User[];
  trainings: Training[];
  assignments: EpiAssignment[];
  aprs: Apr[];
  pts: Pt[];
  dds: Dds[];
  rdos: Rdo[];
  checklists: Checklist[];
  cats: Cat[];
  audits: Audit[];
  nonconformities: NonConformity[];
  attachmentLines: DossierAttachmentLine[];
  governedDocumentLines: DossierGovernedDocumentLine[];
  pendingGovernedDocumentLines: DossierPendingGovernedDocumentLine[];
  governedArtifacts: DossierGovernedArtifact[];
  truncation: DossierTruncationInfo;
}

import { GovernedPdfAccessAvailability } from '../../shared/dto/governed-pdf-access-response.dto';

type DossierKind = 'employee' | 'site';
type DossierPdfAccessAvailability = GovernedPdfAccessAvailability;

type DossierDatasetTruncation = {
  trainings: boolean;
  assignments: boolean;
  pts: boolean;
  cats: boolean;
  workers: boolean;
};

type DossierTruncationInfo = {
  limit: number;
  truncated: boolean;
  datasets: DossierDatasetTruncation;
};

type DossierDocumentSummary = {
  trainings: number;
  assignments: number;
  pts: number;
  cats: number;
  attachments: number;
  officialDocuments: number;
  pendingOfficialDocuments: number;
  supportingAttachments: number;
};

type DossierDocumentInfo = {
  id: string;
  code: string;
  kind: 'employee' | 'site';
  companyId: string;
  companyName: string | null;
  generatedAt: string;
  summary: DossierDocumentSummary;
  truncation: DossierTruncationInfo;
  inclusionPolicy: DossierInclusionPolicy;
};

export type EmployeeDossierContext = DossierDocumentInfo & {
  kind: 'employee';
  subject: {
    id: string;
    nome: string;
    funcao: string | null;
    status: boolean;
    profileName: string | null;
    siteName: string | null;
    cpf: string | null;
    updatedAt: string | null;
  };
  trainings: Array<{
    id: string;
    nome: string;
    nrCodigo: string | null;
    dataConclusao: string | null;
    dataVencimento: string | null;
    status: string;
  }>;
  assignments: Array<{
    id: string;
    epiNome: string;
    ca: string | null;
    validadeCa: string | null;
    status: string;
    entregueEm: string | null;
    devolvidoEm: string | null;
  }>;
  pts: Array<{
    id: string;
    numero: string;
    titulo: string;
    status: string;
    responsavel: string | null;
    dataInicio: string | null;
    dataFim: string | null;
  }>;
  cats: Array<{
    id: string;
    numero: string;
    status: string;
    gravidade: string;
    dataOcorrencia: string | null;
    descricao: string | null;
  }>;
  attachmentLines: DossierAttachmentLine[];
  governedDocumentLines: DossierGovernedDocumentLine[];
  pendingGovernedDocumentLines: DossierPendingGovernedDocumentLine[];
};

export type SiteDossierContext = DossierDocumentInfo & {
  kind: 'site';
  subject: {
    id: string;
    nome: string;
    endereco: string | null;
    cidade: string | null;
    estado: string | null;
    status: boolean;
    updatedAt: string | null;
  };
  workers: Array<{
    id: string;
    nome: string;
    funcao: string | null;
    profileName: string | null;
    status: boolean;
  }>;
  trainings: Array<{
    id: string;
    nome: string;
    workerName: string | null;
    dataConclusao: string | null;
    dataVencimento: string | null;
    status: string;
  }>;
  assignments: Array<{
    id: string;
    workerName: string | null;
    epiNome: string;
    status: string;
    entregueEm: string | null;
    devolvidoEm: string | null;
  }>;
  pts: Array<{
    id: string;
    numero: string;
    titulo: string;
    status: string;
    responsavel: string | null;
    dataInicio: string | null;
    dataFim: string | null;
  }>;
  cats: Array<{
    id: string;
    numero: string;
    status: string;
    gravidade: string;
    workerName: string | null;
    dataOcorrencia: string | null;
  }>;
  attachmentLines: DossierAttachmentLine[];
  governedDocumentLines: DossierGovernedDocumentLine[];
  pendingGovernedDocumentLines: DossierPendingGovernedDocumentLine[];
};

const DOSSIER_RECORD_LIMIT = 500; // Safety limit to prevent memory exhaustion
const DOSSIER_DEGRADED_ATTACHMENT_URL = 'ANEXO_INDISPONIVEL_STORAGE';
const DOSSIER_EMPLOYEE_DOCUMENT_TYPE = 'employee_pdf';
const DOSSIER_SITE_DOCUMENT_TYPE = 'site_pdf';
const DOSSIER_CODE_TRANSITIONAL_EMPLOYEE_REGEX =
  /^DOS-EMP-([A-Z0-9]{8})([A-Z0-9]{4})$/;
const DOSSIER_CODE_TRANSITIONAL_SITE_REGEX =
  /^DOS-SIT-([A-Z0-9]{8})([A-Z0-9]{4})$/;
const DOSSIER_CODE_LEGACY_EMPLOYEE_REGEX = /^DOS-EMP-([A-Z0-9]{8})$/;
const DOSSIER_CODE_LEGACY_SITE_REGEX = /^DOS-SIT-([A-Z0-9]{8})$/;
@Injectable()
export class DossiersService {
  private readonly logger = new Logger(DossiersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Training)
    private readonly trainingsRepository: Repository<Training>,
    @InjectRepository(EpiAssignment)
    private readonly assignmentsRepository: Repository<EpiAssignment>,
    @InjectRepository(Pt)
    private readonly ptsRepository: Repository<Pt>,
    @InjectRepository(Cat)
    private readonly catsRepository: Repository<Cat>,
    @InjectRepository(Apr)
    private readonly aprsRepository: Repository<Apr>,
    @InjectRepository(Dds)
    private readonly ddsRepository: Repository<Dds>,
    @InjectRepository(Rdo)
    private readonly rdosRepository: Repository<Rdo>,
    @InjectRepository(Checklist)
    private readonly checklistsRepository: Repository<Checklist>,
    @InjectRepository(Audit)
    private readonly auditsRepository: Repository<Audit>,
    @InjectRepository(NonConformity)
    private readonly nonconformitiesRepository: Repository<NonConformity>,
    @InjectRepository(Site)
    private readonly sitesRepository: Repository<Site>,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly documentRegistryService: DocumentRegistryService,
  ) {}

  async attachEmployeePdf(
    userId: string,
    file: Express.Multer.File,
    actorId?: string,
  ): Promise<{
    dossierId: string;
    kind: DossierKind;
    hasFinalPdf: boolean;
    availability: DossierPdfAccessAvailability;
    message: string;
    degraded: boolean;
    fileKey: string;
    folderPath: string;
    originalName: string;
    documentCode: string;
    fileHash: string;
  }> {
    const { user, companyId } = await this.requireAccessibleEmployee(userId);

    return this.attachGovernedPdf({
      kind: 'employee',
      entityId: user.id,
      companyId,
      title: `Dossie do colaborador ${user.nome}`,
      documentDate: user.updated_at || user.created_at || new Date(),
      file,
      actorId,
    });
  }

  async attachSitePdf(
    siteId: string,
    file: Express.Multer.File,
    actorId?: string,
  ): Promise<{
    dossierId: string;
    kind: DossierKind;
    hasFinalPdf: boolean;
    availability: DossierPdfAccessAvailability;
    message: string;
    degraded: boolean;
    fileKey: string;
    folderPath: string;
    originalName: string;
    documentCode: string;
    fileHash: string;
  }> {
    const site = await this.requireAccessibleSite(siteId);
    const companyId = site.company_id;

    return this.attachGovernedPdf({
      kind: 'site',
      entityId: site.id,
      companyId,
      title: `Dossie da obra/setor ${site.nome}`,
      documentDate: site.updated_at || site.created_at || new Date(),
      file,
      actorId,
    });
  }

  async getEmployeePdfAccess(
    userId: string,
    actorId?: string,
  ): Promise<{
    dossierId: string;
    kind: DossierKind;
    hasFinalPdf: boolean;
    availability: DossierPdfAccessAvailability;
    message: string;
    degraded: boolean;
    fileKey: string | null;
    folderPath: string | null;
    originalName: string | null;
    fileHash: string | null;
    documentCode: string;
    url: string | null;
  }> {
    const { user, companyId } = await this.requireAccessibleEmployee(userId);

    const payload = await this.getGovernedPdfAccess({
      kind: 'employee',
      entityId: user.id,
      companyId,
      fallbackCode: this.buildEmployeeDossierCode(user.id),
    });

    this.logger.log(
      `dossier_pdf_access_checked kind=employee dossierId=${user.id} hasFinalPdf=${payload.hasFinalPdf} availability=${payload.availability} degraded=${payload.degraded} actor=${actorId || 'system'}`,
    );

    return payload;
  }

  async getSitePdfAccess(
    siteId: string,
    actorId?: string,
  ): Promise<{
    dossierId: string;
    kind: DossierKind;
    hasFinalPdf: boolean;
    availability: DossierPdfAccessAvailability;
    message: string;
    degraded: boolean;
    fileKey: string | null;
    folderPath: string | null;
    originalName: string | null;
    fileHash: string | null;
    documentCode: string;
    url: string | null;
  }> {
    const site = await this.requireAccessibleSite(siteId);
    const companyId = site.company_id;

    const payload = await this.getGovernedPdfAccess({
      kind: 'site',
      entityId: site.id,
      companyId,
      fallbackCode: this.buildSiteDossierCode(site.id),
    });

    this.logger.log(
      `dossier_pdf_access_checked kind=site dossierId=${site.id} hasFinalPdf=${payload.hasFinalPdf} availability=${payload.availability} degraded=${payload.degraded} actor=${actorId || 'system'}`,
    );

    return payload;
  }

  async generateEmployeeDossier(userId: string): Promise<{
    filename: string;
    buffer: Buffer;
  }> {
    const {
      user,
      trainings,
      assignments,
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
    } = await this.loadEmployeeDossierBundle(userId);

    // ALERTA DE PERFORMANCE: Geração de PDF é síncrona e bloqueia o event loop.
    // RECOMENDAÇÃO: Mover para um job em background (BullMQ) para não afetar a API.
    let logoBase64: string | null = null;
    let logoFormat: 'PNG' | 'JPEG' = 'PNG';
    if (user.company?.logo_storage_key) {
      try {
        const buf = await this.documentStorageService.downloadFileBuffer(
          this.documentStorageService.referenceForExistingObject(
            user.company.logo_storage_key,
            {
              resourceType: 'company',
              resourceId: user.company.id,
            },
            'company-logo',
          ),
        );
        logoBase64 = buf.toString('base64');
        logoFormat = user.company.logo_content_type?.includes('png')
          ? 'PNG'
          : 'JPEG';
      } catch {
        // logo inacessível — PDF gerado sem logo
      }
    }
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    this.buildPdf(doc, {
      user,
      trainings,
      assignments,
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
      logoBase64,
      logoFormat,
    });

    const filename = `dossie_colaborador_${user.id}_${new Date().toISOString().slice(0, 10)}.pdf`;
    const buffer = Buffer.from(doc.output('arraybuffer'));
    return { filename, buffer };
  }

  async generateEmployeeBundleArchive(userId: string): Promise<{
    filename: string;
    buffer: Buffer;
  }> {
    const bundle = await this.loadEmployeeDossierBundle(userId);
    const context = await this.getEmployeeDossierContext(userId);

    return this.buildDossierBundleArchive({
      filenameBase: `dossie_colaborador_${bundle.user.nome}`,
      dossierCode: context.code,
      context,
      officialArtifacts: bundle.governedArtifacts,
      generatedAt: context.generatedAt,
    });
  }

  async generateSiteBundleArchive(siteId: string): Promise<{
    filename: string;
    buffer: Buffer;
  }> {
    const bundle = await this.loadSiteDossierBundle(siteId);
    const context = await this.getSiteDossierContext(siteId);

    return this.buildDossierBundleArchive({
      filenameBase: `dossie_site_${bundle.site.nome}`,
      dossierCode: context.code,
      context,
      officialArtifacts: bundle.governedArtifacts,
      generatedAt: context.generatedAt,
    });
  }

  async getEmployeeDossierContext(
    userId: string,
  ): Promise<EmployeeDossierContext> {
    const {
      user,
      trainings,
      assignments,
      pts,
      cats,
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
      truncation,
    } = await this.loadEmployeeDossierBundle(userId);
    const generatedAt = new Date().toISOString();
    const companyName = user.company?.razao_social || null;
    const registryEntry = await this.documentRegistryService.findByDocument(
      'dossier',
      user.id,
      DOSSIER_EMPLOYEE_DOCUMENT_TYPE,
      user.company_id,
    );
    const documentCode =
      registryEntry?.document_code || this.buildEmployeeDossierCode(user.id);

    return {
      kind: 'employee',
      id: user.id,
      code: documentCode,
      companyId: user.company_id,
      companyName,
      generatedAt,
      summary: {
        trainings: trainings.length,
        assignments: assignments.length,
        pts: pts.length,
        cats: cats.length,
        attachments: attachmentLines.length,
        officialDocuments: governedDocumentLines.length,
        pendingOfficialDocuments: pendingGovernedDocumentLines.length,
        supportingAttachments: attachmentLines.length,
      },
      truncation,
      inclusionPolicy: this.buildInclusionPolicy(),
      subject: {
        id: user.id,
        nome: user.nome,
        funcao: user.funcao || null,
        status: Boolean(user.status),
        profileName: user.profile?.nome || null,
        siteName: user.site?.nome || null,
        cpf: user.cpf || null,
        updatedAt: this.serializeDate(user.updated_at),
      },
      trainings: trainings.map((item) => ({
        id: item.id,
        nome: item.nome,
        nrCodigo: item.nr_codigo || null,
        dataConclusao: this.serializeDate(item.data_conclusao),
        dataVencimento: this.serializeDate(item.data_vencimento),
        status:
          item.data_vencimento && new Date(item.data_vencimento) < new Date()
            ? 'Vencido'
            : 'Valido',
      })),
      assignments: assignments.map((item) => ({
        id: item.id,
        epiNome: item.epi?.nome || item.epi_id,
        ca: item.ca || null,
        validadeCa: this.serializeDate(item.validade_ca),
        status: item.status,
        entregueEm: this.serializeDate(item.entregue_em),
        devolvidoEm: this.serializeDate(item.devolvido_em),
      })),
      pts: pts.map((item) => ({
        id: item.id,
        numero: item.numero,
        titulo: item.titulo,
        status: item.status,
        responsavel: item.responsavel?.nome || null,
        dataInicio: this.serializeDate(item.data_hora_inicio),
        dataFim: this.serializeDate(item.data_hora_fim),
      })),
      cats: cats.map((item) => ({
        id: item.id,
        numero: item.numero,
        status: item.status,
        gravidade: item.gravidade,
        dataOcorrencia: this.serializeDate(item.data_ocorrencia),
        descricao: item.descricao || null,
      })),
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
    };
  }

  async getSiteDossierContext(siteId: string): Promise<SiteDossierContext> {
    const {
      site,
      users,
      trainings,
      assignments,
      pts,
      cats,
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
      truncation,
    } = await this.loadSiteDossierBundle(siteId);
    const generatedAt = new Date().toISOString();
    const registryEntry = await this.documentRegistryService.findByDocument(
      'dossier',
      site.id,
      DOSSIER_SITE_DOCUMENT_TYPE,
      site.company_id,
    );
    const documentCode =
      registryEntry?.document_code || this.buildSiteDossierCode(site.id);

    return {
      kind: 'site',
      id: site.id,
      code: documentCode,
      companyId: site.company_id,
      companyName: site.company?.razao_social || null,
      generatedAt,
      summary: {
        trainings: trainings.length,
        assignments: assignments.length,
        pts: pts.length,
        cats: cats.length,
        attachments: attachmentLines.length,
        officialDocuments: governedDocumentLines.length,
        pendingOfficialDocuments: pendingGovernedDocumentLines.length,
        supportingAttachments: attachmentLines.length,
      },
      truncation,
      inclusionPolicy: this.buildInclusionPolicy(),
      subject: {
        id: site.id,
        nome: site.nome,
        endereco: site.endereco || null,
        cidade: site.cidade || null,
        estado: site.estado || null,
        status: Boolean(site.status),
        updatedAt: this.serializeDate(site.updated_at),
      },
      workers: users.map((user) => ({
        id: user.id,
        nome: user.nome,
        funcao: user.funcao || null,
        profileName: user.profile?.nome || null,
        status: Boolean(user.status),
      })),
      trainings: trainings.map((item) => ({
        id: item.id,
        nome: item.nome,
        workerName: item.user?.nome || null,
        dataConclusao: this.serializeDate(item.data_conclusao),
        dataVencimento: this.serializeDate(item.data_vencimento),
        status:
          item.data_vencimento && new Date(item.data_vencimento) < new Date()
            ? 'Vencido'
            : 'Valido',
      })),
      assignments: assignments.map((item) => ({
        id: item.id,
        workerName: item.user?.nome || null,
        epiNome: item.epi?.nome || item.epi_id,
        status: item.status,
        entregueEm: this.serializeDate(item.entregue_em),
        devolvidoEm: this.serializeDate(item.devolvido_em),
      })),
      pts: pts.map((item) => ({
        id: item.id,
        numero: item.numero,
        titulo: item.titulo,
        status: item.status,
        responsavel: item.responsavel?.nome || null,
        dataInicio: this.serializeDate(item.data_hora_inicio),
        dataFim: this.serializeDate(item.data_hora_fim),
      })),
      cats: cats.map((item) => ({
        id: item.id,
        numero: item.numero,
        status: item.status,
        gravidade: item.gravidade,
        workerName: item.worker?.nome || null,
        dataOcorrencia: this.serializeDate(item.data_ocorrencia),
      })),
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
    };
  }

  async validateByCode(
    code: string,
    companyId: string,
  ): Promise<{
    valid: boolean;
    code?: string;
    message?: string;
  }> {
    const normalizedCode = String(code || '')
      .trim()
      .toUpperCase();
    if (!normalizedCode.startsWith('DOS-')) {
      return {
        valid: false,
        message: 'Código inválido ou expirado.',
      };
    }

    return this.documentRegistryService.validatePublicCode({
      code: normalizedCode,
      companyId,
      expectedModule: 'dossier',
    });
  }

  async validateByCodeLegacy(code: string): Promise<{
    valid: boolean;
    code?: string;
    message?: string;
  }> {
    const normalizedCode = String(code || '')
      .trim()
      .toUpperCase();
    if (!normalizedCode.startsWith('DOS-')) {
      return {
        valid: false,
        message: 'Código inválido ou expirado.',
      };
    }

    return this.documentRegistryService.validateLegacyPublicCode({
      code: normalizedCode,
      expectedModule: 'dossier',
    });
  }

  private buildPdf(doc: jsPDF, data: EmployeeDossierPdfData): void {
    const {
      user,
      trainings,
      assignments,
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
      logoBase64,
      logoFormat,
    } = data;
    const marginX = 14;
    const tableTheme = createBackendPdfTableTheme();

    drawBackendPdfHeader(doc, {
      title: 'Dossie de SST - Colaborador',
      subtitle: `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
      metaRight: [`ID do colaborador: ${user.id}`],
      marginX,
      logoBase64,
      logoFormat,
    });

    doc.setFontSize(12);
    doc.setTextColor(...backendPdfTheme.text);
    doc.text('Dados do colaborador', marginX, 35);
    autoTable(doc, {
      startY: 40,
      head: [['Campo', 'Valor']],
      body: [
        ['Nome', user.nome],
        ['Funcao', user.funcao || '-'],
        ['Perfil', user.profile?.nome || '-'],
        ['Obra/Setor', user.site?.nome || '-'],
        ['Status', user.status ? 'Ativo' : 'Inativo'],
      ],
      ...tableTheme,
    });

    autoTable(doc, {
      startY: getBackendLastTableY(doc) + 6,
      head: [['Treinamento', 'NR', 'Conclusao', 'Vencimento', 'Status']],
      body:
        trainings.length > 0
          ? trainings.map((item: Training) => [
              item.nome,
              item.nr_codigo || '-',
              new Date(item.data_conclusao).toLocaleDateString('pt-BR'),
              new Date(item.data_vencimento).toLocaleDateString('pt-BR'),
              new Date(item.data_vencimento) < new Date()
                ? 'Vencido'
                : 'Valido',
            ])
          : [['-', '-', '-', '-', 'Nenhum treinamento encontrado']],
      ...tableTheme,
    });

    autoTable(doc, {
      startY: getBackendLastTableY(doc) + 6,
      head: [['EPI', 'CA', 'Validade CA', 'Status', 'Entrega', 'Devolucao']],
      body:
        assignments.length > 0
          ? assignments.map((item: EpiAssignment) => [
              item.epi?.nome || item.epi_id,
              item.ca || '-',
              item.validade_ca
                ? new Date(item.validade_ca).toLocaleDateString('pt-BR')
                : '-',
              item.status,
              new Date(item.entregue_em).toLocaleDateString('pt-BR'),
              item.devolvido_em
                ? new Date(item.devolvido_em).toLocaleDateString('pt-BR')
                : '-',
            ])
          : [['-', '-', '-', '-', '-', 'Nenhuma ficha EPI encontrada']],
      ...tableTheme,
    });

    this.appendGovernedDocumentIndex(doc, governedDocumentLines);
    this.appendPendingGovernedDocumentIndex(doc, pendingGovernedDocumentLines);
    this.appendAttachmentIndex(doc, attachmentLines);
    applyBackendPdfFooter(doc, { marginX });
  }

  private async collectEmployeeAttachments(
    trainings: Training[],
    _assignments: EpiAssignment[],
    _pts: Pt[],
    cats: Cat[],
  ): Promise<DossierAttachmentLine[]> {
    const lines: DossierAttachmentLine[] = [];
    for (const training of trainings) {
      if (training.certificado_url) {
        lines.push({
          tipo: 'Treinamento',
          referencia: training.nome,
          arquivo: 'Certificado',
          url: training.certificado_url,
        });
      }
    }
    // Attachment collection for assignments is omitted as it was complex and didn't use URLs.
    // PT e CAT oficiais entram pelo registry governado, não como anexo solto.
    await this.appendSupportingAttachments(lines, cats);
    return lines;
  }

  private async collectSiteAttachments(
    trainings: Training[],
    assignments: EpiAssignment[],
    pts: Pt[],
    cats: Cat[],
  ): Promise<DossierAttachmentLine[]> {
    return this.collectEmployeeAttachments(trainings, assignments, pts, cats);
  }

  private async appendSupportingAttachments(
    lines: DossierAttachmentLine[],
    cats: Cat[],
  ) {
    const catPromises = cats.flatMap((cat) =>
      (cat.attachments || []).map(async (attachment) => ({
        tipo: 'CAT / Anexo complementar',
        referencia: cat.numero,
        arquivo: attachment.file_name,
        url: await this.safeSignedUrl(attachment.file_key, {
          resourceType: 'cat-attachment',
          resourceId: cat.id,
        }),
      })),
    );

    const results = await Promise.all(catPromises);
    lines.push(...results);
  }

  private async collectGovernedDocumentLines(
    companyId: string,
    candidates: Array<{
      modulo: GovernedDossierModule;
      entityId: string;
      referencia: string;
      statusAtual?: string | null;
      fallbackFileName?: string | null;
    }>,
  ): Promise<{
    governedDocumentLines: DossierGovernedDocumentLine[];
    pendingGovernedDocumentLines: DossierPendingGovernedDocumentLine[];
    governedArtifacts: DossierGovernedArtifact[];
  }> {
    const seen = new Set<string>();
    const uniqueCandidates = candidates.filter((candidate) => {
      const key = `${candidate.modulo}:${candidate.entityId}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    // Batch-fetch all registry entries in one query instead of one per candidate (N queries -> 1)
    const registryBatch =
      await this.documentRegistryService.findManyByDocuments(
        companyId,
        uniqueCandidates.map((c) => ({
          module: c.modulo,
          entityId: c.entityId,
        })),
      );
    const registryMap = new Map(
      registryBatch.map((e) => [`${e.module}:${e.entity_id}`, e]),
    );

    // Process signed URL validation with capped concurrency to protect the B2 connection pool
    const SIGNED_URL_CONCURRENCY = 10;
    const results: Array<
      | { kind: 'pending'; value: DossierPendingGovernedDocumentLine }
      | {
          kind: 'governed';
          value: DossierGovernedDocumentLine;
          artifact: DossierGovernedArtifact;
        }
    > = [];
    for (let i = 0; i < uniqueCandidates.length; i += SIGNED_URL_CONCURRENCY) {
      const chunk = uniqueCandidates.slice(i, i + SIGNED_URL_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (candidate) => {
          const registryEntry =
            registryMap.get(`${candidate.modulo}:${candidate.entityId}`) ??
            null;

          if (!registryEntry?.file_key) {
            return {
              kind: 'pending' as const,
              value: {
                modulo: candidate.modulo,
                modulo_label: this.getGovernedModuleLabel(candidate.modulo),
                referencia: candidate.referencia,
                status_atual: candidate.statusAtual || null,
                pendencia:
                  'Documento oficial ainda não possui PDF final governado emitido.',
              },
            };
          }

          let availability: DossierGovernedDocumentLine['disponibilidade'] =
            'ready';
          try {
            await this.documentStorageService.getSignedUrl(
              this.documentStorageService.referenceForExistingObject(
                registryEntry.file_key,
                {
                  resourceType: candidate.modulo,
                  resourceId: candidate.entityId,
                },
                'p1-document-storage-getSignedUrl',
              ),
            );
          } catch (error) {
            availability = 'registered_without_signed_url';
            this.logger.warn(
              `Falha ao validar URL segura do documento governado ${candidate.modulo}:${candidate.entityId} para composição do dossiê: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          return {
            kind: 'governed' as const,
            value: {
              modulo: candidate.modulo,
              modulo_label: this.getGovernedModuleLabel(candidate.modulo),
              referencia: candidate.referencia,
              codigo_documento: registryEntry.document_code || null,
              arquivo:
                registryEntry.original_name ||
                candidate.fallbackFileName ||
                registryEntry.file_key.split('/').pop() ||
                'documento.pdf',
              disponibilidade: availability,
              emitido_em: this.serializeDate(registryEntry.created_at),
            },
            artifact: {
              modulo: candidate.modulo,
              modulo_label: this.getGovernedModuleLabel(candidate.modulo),
              entityId: candidate.entityId,
              referencia: candidate.referencia,
              codigo_documento: registryEntry.document_code || null,
              arquivo:
                registryEntry.original_name ||
                candidate.fallbackFileName ||
                registryEntry.file_key.split('/').pop() ||
                'documento.pdf',
              disponibilidade: availability,
              emitido_em: this.serializeDate(registryEntry.created_at),
              fileKey: registryEntry.file_key,
              fileHash: registryEntry.file_hash || null,
            },
          };
        }),
      );
      results.push(...chunkResults);
    }

    const governedDocumentLines = results
      .flatMap((result) => (result.kind === 'governed' ? [result.value] : []))
      .sort((left, right) =>
        `${left.modulo_label}:${left.referencia}`.localeCompare(
          `${right.modulo_label}:${right.referencia}`,
          'pt-BR',
        ),
      );

    const governedArtifacts = results
      .flatMap((result) =>
        result.kind === 'governed' ? [result.artifact] : [],
      )
      .sort((left, right) =>
        `${left.modulo_label}:${left.referencia}`.localeCompare(
          `${right.modulo_label}:${right.referencia}`,
          'pt-BR',
        ),
      );

    const pendingGovernedDocumentLines = results
      .filter(
        (
          result,
        ): result is {
          kind: 'pending';
          value: DossierPendingGovernedDocumentLine;
        } => result.kind === 'pending',
      )
      .map((result) => result.value)
      .sort((left, right) =>
        `${left.modulo_label}:${left.referencia}`.localeCompare(
          `${right.modulo_label}:${right.referencia}`,
          'pt-BR',
        ),
      );

    return {
      governedDocumentLines,
      pendingGovernedDocumentLines,
      governedArtifacts,
    };
  }

  private appendAttachmentIndex(
    doc: jsPDF,
    attachmentLines: DossierAttachmentLine[],
  ) {
    drawBackendSectionTitle(
      doc,
      getBackendLastTableY(doc) + 4,
      'Indice de anexos de apoio',
    );
    autoTable(doc, {
      startY: getBackendLastTableY(doc) + 6,
      head: [['Tipo', 'Referencia', 'Arquivo', 'URL/Chave']],
      body:
        attachmentLines.length > 0
          ? attachmentLines.map((item) => [
              item.tipo,
              item.referencia,
              item.arquivo,
              item.url,
            ])
          : [['-', '-', '-', 'Nenhum anexo complementar relacionado']],
      ...createBackendPdfTableTheme(),
      styles: {
        ...createBackendPdfTableTheme().styles,
        fontSize: 8,
      },
    });
  }

  private appendGovernedDocumentIndex(
    doc: jsPDF,
    governedDocumentLines: DossierGovernedDocumentLine[],
  ) {
    drawBackendSectionTitle(
      doc,
      getBackendLastTableY(doc) + 4,
      'Documentos oficiais governados',
    );
    autoTable(doc, {
      startY: getBackendLastTableY(doc) + 6,
      head: [['Modulo', 'Referencia', 'Codigo', 'Arquivo', 'Disponibilidade']],
      body:
        governedDocumentLines.length > 0
          ? governedDocumentLines.map((item) => [
              item.modulo_label,
              item.referencia,
              item.codigo_documento || '-',
              item.arquivo,
              item.disponibilidade === 'ready'
                ? 'Pronto'
                : 'Registrado sem URL assinada',
            ])
          : [
              [
                '-',
                '-',
                '-',
                '-',
                'Nenhum documento oficial governado relacionado',
              ],
            ],
      ...createBackendPdfTableTheme(),
      styles: {
        ...createBackendPdfTableTheme().styles,
        fontSize: 8,
      },
    });
  }

  private appendPendingGovernedDocumentIndex(
    doc: jsPDF,
    pendingGovernedDocumentLines: DossierPendingGovernedDocumentLine[],
  ) {
    drawBackendSectionTitle(
      doc,
      getBackendLastTableY(doc) + 4,
      'Pendencias documentais oficiais',
    );
    autoTable(doc, {
      startY: getBackendLastTableY(doc) + 6,
      head: [['Modulo', 'Referencia', 'Status atual', 'Pendencia']],
      body:
        pendingGovernedDocumentLines.length > 0
          ? pendingGovernedDocumentLines.map((item) => [
              item.modulo_label,
              item.referencia,
              item.status_atual || '-',
              item.pendencia,
            ])
          : [
              [
                '-',
                '-',
                '-',
                'Nenhuma pendencia documental oficial identificada',
              ],
            ],
      ...createBackendPdfTableTheme(),
      styles: {
        ...createBackendPdfTableTheme().styles,
        fontSize: 8,
      },
    });
  }

  private getGovernedModuleLabel(module: GovernedDossierModule): string {
    switch (module) {
      case 'apr':
        return 'APR';
      case 'pt':
        return 'PT';
      case 'dds':
        return 'DDS';
      case 'rdo':
        return 'RDO';
      case 'checklist':
        return 'Checklist';
      case 'cat':
        return 'CAT';
      case 'audit':
        return 'Auditoria';
      case 'nonconformity':
        return 'Não Conformidade';
      default:
        return 'Documento';
    }
  }

  private async safeSignedUrl(
    fileKey: string,
    owner: { resourceType: string; resourceId: string },
  ): Promise<string> {
    try {
      // CORREÇÃO: Chamando o método correto `getPresignedDownloadUrl`
      return await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          owner,
          'p1-document-storage-getSignedUrl',
        ),
      );
    } catch (error) {
      this.logger.error({
        event: 'dossier_signed_url_failed',
        keyFingerprint: storageKeyFingerprint(fileKey),
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
      return DOSSIER_DEGRADED_ATTACHMENT_URL;
    }
  }

  private getTenantIdOrThrow(): string {
    return this.getTenantContextOrThrow().companyId;
  }

  private getTenantContextOrThrow(): {
    companyId: string;
    siteId?: string;
    siteScope: 'single' | 'all';
    isSuperAdmin: boolean;
  } {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'dossies',
    );

    return {
      companyId: scope.companyId,
      siteId: scope.siteId,
      siteScope: scope.siteScope,
      isSuperAdmin: scope.isSuperAdmin,
    };
  }

  private async requireAccessibleEmployee(userId: string): Promise<{
    user: User;
    companyId: string;
  }> {
    const { companyId, siteId, siteScope, isSuperAdmin } =
      this.getTenantContextOrThrow();
    const user = await this.usersRepository.findOne({
      where: { id: userId, company_id: companyId },
      relations: ['site', 'profile', 'company'],
    });
    if (!user) {
      throw new NotFoundException('Colaborador nao encontrado.');
    }

    if (!isSuperAdmin && siteScope !== 'all' && user.site_id !== siteId) {
      throw new NotFoundException('Colaborador nao encontrado.');
    }

    return { user, companyId };
  }

  private async requireAccessibleSite(siteId: string): Promise<Site> {
    const {
      companyId,
      siteId: currentSiteId,
      siteScope,
      isSuperAdmin,
    } = this.getTenantContextOrThrow();
    const site = await this.sitesRepository.findOne({
      where: { id: siteId, company_id: companyId },
      relations: ['company'],
    });
    if (!site) {
      throw new NotFoundException('Obra/setor nao encontrado.');
    }

    if (!isSuperAdmin && siteScope !== 'all' && site.id !== currentSiteId) {
      throw new NotFoundException('Obra/setor nao encontrado.');
    }

    return site;
  }

  private async loadEmployeeDossierBundle(
    userId: string,
  ): Promise<EmployeeDossierBundle> {
    const { user, companyId } = await this.requireAccessibleEmployee(userId);

    this.logger.warn(
      `Aplicando limite de ${DOSSIER_RECORD_LIMIT} registros por categoria no dossiê.`,
    );

    const [trainings, assignments, responsiblePts, executingPts, cats] =
      await Promise.all([
        this.trainingsRepository.find({
          where: { company_id: companyId, user_id: userId },
          order: { data_vencimento: 'ASC' },
          take: DOSSIER_RECORD_LIMIT,
        }),
        this.assignmentsRepository.find({
          where: { company_id: companyId, user_id: userId },
          relations: ['epi'],
          order: { created_at: 'DESC' },
          take: DOSSIER_RECORD_LIMIT,
        }),
        this.ptsRepository.find({
          where: { company_id: companyId, responsavel_id: userId },
          relations: ['responsavel'],
          order: { created_at: 'DESC' },
          take: DOSSIER_RECORD_LIMIT,
        }),
        this.ptsRepository
          .createQueryBuilder('pt')
          .leftJoin('pt.executantes', 'executante')
          .leftJoinAndSelect('pt.responsavel', 'responsavel')
          .where('pt.company_id = :companyId', { companyId })
          .andWhere('pt.deleted_at IS NULL')
          .andWhere('executante.id = :userId', { userId })
          .orderBy('pt.created_at', 'DESC')
          .take(DOSSIER_RECORD_LIMIT)
          .getMany(),
        this.catsRepository.find({
          where: { company_id: companyId, worker_id: userId },
          order: { created_at: 'DESC' },
          take: DOSSIER_RECORD_LIMIT,
        }),
      ]);

    const ptsMap = new Map<string, Pt>();
    [...responsiblePts, ...executingPts].forEach((pt) => ptsMap.set(pt.id, pt));
    const pts = [...ptsMap.values()];
    const attachmentLines = await this.collectEmployeeAttachments(
      trainings,
      assignments,
      pts,
      cats,
    );
    const {
      governedDocumentLines,
      pendingGovernedDocumentLines,
      governedArtifacts,
    } = await this.collectGovernedDocumentLines(companyId, [
      ...pts.map((pt) => ({
        modulo: 'pt' as const,
        entityId: pt.id,
        referencia: pt.numero,
        statusAtual: pt.status,
        fallbackFileName: pt.pdf_original_name || null,
      })),
      ...cats.map((cat) => ({
        modulo: 'cat' as const,
        entityId: cat.id,
        referencia: cat.numero,
        statusAtual: cat.status,
        fallbackFileName: cat.pdf_original_name || null,
      })),
    ]);

    return {
      user,
      trainings,
      assignments,
      pts,
      cats,
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
      governedArtifacts,
      truncation: this.buildTruncationInfo({
        trainings: trainings.length >= DOSSIER_RECORD_LIMIT,
        assignments: assignments.length >= DOSSIER_RECORD_LIMIT,
        pts: pts.length >= DOSSIER_RECORD_LIMIT,
        cats: cats.length >= DOSSIER_RECORD_LIMIT,
        workers: false,
      }),
    };
  }

  private async loadSiteDossierBundle(
    siteId: string,
  ): Promise<SiteDossierBundle> {
    const site = await this.requireAccessibleSite(siteId);
    const companyId = site.company_id;

    this.logger.warn(
      `Aplicando limite de ${DOSSIER_RECORD_LIMIT} registros por categoria no dossiê.`,
    );

    const users = await this.usersRepository.find({
      where: { company_id: companyId, site_id: siteId },
      relations: ['profile'],
      order: { nome: 'ASC' },
      take: DOSSIER_RECORD_LIMIT,
    });

    const userIds = users.map((item) => item.id);
    const [
      trainings,
      assignments,
      aprs,
      pts,
      dds,
      rdos,
      checklists,
      cats,
      audits,
      nonconformities,
    ] = await Promise.all([
      userIds.length
        ? this.trainingsRepository.find({
            where: {
              company_id: companyId,
              user_id: In(userIds),
            },
            relations: ['user'],
            order: { data_vencimento: 'ASC' },
            take: DOSSIER_RECORD_LIMIT,
          })
        : Promise.resolve([]),
      userIds.length
        ? this.assignmentsRepository.find({
            where: {
              company_id: companyId,
              user_id: In(userIds),
            },
            relations: ['epi', 'user'],
            order: { created_at: 'DESC' },
            take: DOSSIER_RECORD_LIMIT,
          })
        : Promise.resolve([]),
      this.aprsRepository.find({
        where: { company_id: companyId, site_id: siteId },
        order: { created_at: 'DESC' },
        take: DOSSIER_RECORD_LIMIT,
      }),
      this.ptsRepository.find({
        where: { company_id: companyId, site_id: siteId },
        relations: ['responsavel'],
        order: { created_at: 'DESC' },
        take: DOSSIER_RECORD_LIMIT,
      }),
      this.ddsRepository.find({
        where: { company_id: companyId, site_id: siteId },
        order: { created_at: 'DESC' },
        take: DOSSIER_RECORD_LIMIT,
      }),
      this.rdosRepository.find({
        where: { company_id: companyId, site_id: siteId },
        order: { created_at: 'DESC' },
        take: DOSSIER_RECORD_LIMIT,
      }),
      this.checklistsRepository.find({
        where: { company_id: companyId, site_id: siteId, is_modelo: false },
        order: { created_at: 'DESC' },
        take: DOSSIER_RECORD_LIMIT,
      }),
      this.catsRepository.find({
        where: { company_id: companyId, site_id: siteId },
        relations: ['worker'],
        order: { created_at: 'DESC' },
        take: DOSSIER_RECORD_LIMIT,
      }),
      this.auditsRepository.find({
        where: { company_id: companyId, site_id: siteId },
        order: { created_at: 'DESC' },
        take: DOSSIER_RECORD_LIMIT,
      }),
      this.nonconformitiesRepository.find({
        where: { company_id: companyId, site_id: siteId },
        order: { created_at: 'DESC' },
        take: DOSSIER_RECORD_LIMIT,
      }),
    ]);

    const attachmentLines = await this.collectSiteAttachments(
      trainings,
      assignments,
      pts,
      cats,
    );
    const {
      governedDocumentLines,
      pendingGovernedDocumentLines,
      governedArtifacts,
    } = await this.collectGovernedDocumentLines(companyId, [
      ...aprs.map((apr) => ({
        modulo: 'apr' as const,
        entityId: apr.id,
        referencia: apr.numero,
        statusAtual: apr.status,
        fallbackFileName: apr.pdf_original_name || null,
      })),
      ...pts.map((pt) => ({
        modulo: 'pt' as const,
        entityId: pt.id,
        referencia: pt.numero,
        statusAtual: pt.status,
        fallbackFileName: pt.pdf_original_name || null,
      })),
      ...dds.map((dds) => ({
        modulo: 'dds' as const,
        entityId: dds.id,
        referencia: dds.tema,
        statusAtual: dds.status,
        fallbackFileName: dds.pdf_original_name || null,
      })),
      ...rdos.map((rdo) => ({
        modulo: 'rdo' as const,
        entityId: rdo.id,
        referencia: rdo.numero,
        statusAtual: rdo.status,
        fallbackFileName: rdo.pdf_original_name || null,
      })),
      ...checklists.map((checklist) => ({
        modulo: 'checklist' as const,
        entityId: checklist.id,
        referencia: checklist.titulo,
        statusAtual: checklist.status,
        fallbackFileName: checklist.pdf_original_name || null,
      })),
      ...cats.map((cat) => ({
        modulo: 'cat' as const,
        entityId: cat.id,
        referencia: cat.numero,
        statusAtual: cat.status,
        fallbackFileName: cat.pdf_original_name || null,
      })),
      ...audits.map((audit) => ({
        modulo: 'audit' as const,
        entityId: audit.id,
        referencia: audit.titulo,
        statusAtual: null,
        fallbackFileName: audit.pdf_original_name || null,
      })),
      ...nonconformities.map((nonconformity) => ({
        modulo: 'nonconformity' as const,
        entityId: nonconformity.id,
        referencia: nonconformity.codigo_nc,
        statusAtual: nonconformity.status,
        fallbackFileName: nonconformity.pdf_original_name || null,
      })),
    ]);

    return {
      site,
      users,
      trainings,
      assignments,
      aprs,
      pts,
      dds,
      rdos,
      checklists,
      cats,
      audits,
      nonconformities,
      attachmentLines,
      governedDocumentLines,
      pendingGovernedDocumentLines,
      governedArtifacts,
      truncation: this.buildTruncationInfo({
        trainings: trainings.length >= DOSSIER_RECORD_LIMIT,
        assignments: assignments.length >= DOSSIER_RECORD_LIMIT,
        pts: pts.length >= DOSSIER_RECORD_LIMIT,
        cats: cats.length >= DOSSIER_RECORD_LIMIT,
        workers: users.length >= DOSSIER_RECORD_LIMIT,
      }),
    };
  }

  private buildInclusionPolicy(): DossierInclusionPolicy {
    return {
      officialDocuments:
        'Entram automaticamente apenas documentos oficiais governados já registrados no document registry com PDF final válido.',
      pendingOfficialDocuments:
        'Documentos sem PDF final governado não entram como arquivo físico; aparecem somente como pendência explícita no contexto e no manifesto.',
      supportingAttachments:
        'Anexos complementares permanecem separados dos documentos oficiais e nunca substituem artefatos governados de fechamento.',
      zipBundle:
        'O ZIP do dossiê inclui manifesto, contexto serializado e somente artefatos oficiais governados disponíveis no storage.',
      notes: [
        'Estado degradado não é tratado como saudável.',
        'Ausência de artefato oficial continua visível no manifesto.',
        'A mesma storage key governada é preservada como referência do bundle.',
      ],
    };
  }

  private async buildDossierBundleArchive(input: {
    filenameBase: string;
    dossierCode: string;
    context: EmployeeDossierContext | SiteDossierContext;
    officialArtifacts: DossierGovernedArtifact[];
    generatedAt: string;
  }): Promise<{ filename: string; buffer: Buffer }> {
    const zip = new JSZip();
    const officialFolder = zip.folder('documentos-oficiais');
    if (!officialFolder) {
      throw new Error(
        'Não foi possível inicializar a pasta de documentos oficiais do bundle.',
      );
    }

    const officialArtifactResults = await Promise.allSettled(
      input.officialArtifacts.map(async (artifact, index) => {
        const safeName = this.sanitizeBundleFileName(
          artifact.arquivo || `${artifact.modulo}-${artifact.entityId}.pdf`,
          index,
        );
        const buffer = await this.documentStorageService.downloadFileBuffer(
          this.documentStorageService.referenceForExistingObject(
            artifact.fileKey,
            {
              resourceType: artifact.modulo,
              resourceId: artifact.entityId,
            },
            'p1-document-storage-downloadFileBuffer',
          ),
        );

        return {
          artifact,
          safeName,
          buffer,
        };
      }),
    );

    const includedOfficialDocuments: Array<{
      modulo: GovernedDossierModule;
      moduloLabel: string;
      referencia: string;
      documentCode: string | null;
      fileName: string;
      availability: 'ready' | 'registered_without_signed_url';
      emittedAt: string | null;
      fileHash: string | null;
      fileKey: string;
    }> = [];
    const missingOfficialDocuments: Array<{
      modulo: GovernedDossierModule;
      moduloLabel: string;
      referencia: string;
      documentCode: string | null;
      fileName: string;
      availability: 'ready' | 'registered_without_signed_url';
      fileKey: string;
      reason: string;
    }> = [];

    officialArtifactResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        officialFolder.file(result.value.safeName, result.value.buffer);
        includedOfficialDocuments.push({
          modulo: result.value.artifact.modulo,
          moduloLabel: result.value.artifact.modulo_label,
          referencia: result.value.artifact.referencia,
          documentCode: result.value.artifact.codigo_documento,
          fileName: result.value.safeName,
          availability: result.value.artifact.disponibilidade,
          emittedAt: result.value.artifact.emitido_em,
          fileHash: result.value.artifact.fileHash,
          fileKey: result.value.artifact.fileKey,
        });
        return;
      }

      const artifact = input.officialArtifacts[index];
      const safeName = this.sanitizeBundleFileName(
        artifact.arquivo || `${artifact.modulo}-${artifact.entityId}.pdf`,
        index,
      );
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);

      this.logger.warn({
        event: 'dossier_official_artifact_bundle_attach_failed',
        dossierCode: input.dossierCode,
        module: artifact.modulo,
        entityId: artifact.entityId,
        keyFingerprint: storageKeyFingerprint(artifact.fileKey),
        reason,
      });

      missingOfficialDocuments.push({
        modulo: artifact.modulo,
        moduloLabel: artifact.modulo_label,
        referencia: artifact.referencia,
        documentCode: artifact.codigo_documento,
        fileName: safeName,
        availability: artifact.disponibilidade,
        fileKey: artifact.fileKey,
        reason,
      });
    });

    const manifest = {
      dossierCode: input.dossierCode,
      kind: input.context.kind,
      generatedAt: input.generatedAt,
      companyId: input.context.companyId,
      companyName: input.context.companyName,
      summary: input.context.summary,
      inclusionPolicy: input.context.inclusionPolicy,
      bundleStatus: {
        requestedOfficialDocuments: input.officialArtifacts.length,
        includedOfficialDocuments: includedOfficialDocuments.length,
        missingOfficialDocuments: missingOfficialDocuments.length,
        degraded: missingOfficialDocuments.length > 0,
      },
      officialDocuments: input.officialArtifacts.map((artifact) => ({
        modulo: artifact.modulo,
        moduloLabel: artifact.modulo_label,
        referencia: artifact.referencia,
        documentCode: artifact.codigo_documento,
        fileName: artifact.arquivo,
        availability: artifact.disponibilidade,
        emittedAt: artifact.emitido_em,
        fileHash: artifact.fileHash,
        fileKey: artifact.fileKey,
      })),
      includedOfficialDocuments,
      missingOfficialDocuments,
      pendingOfficialDocuments: input.context.pendingGovernedDocumentLines,
      supportingAttachments: input.context.attachmentLines.map(
        (attachment) => ({
          tipo: attachment.tipo,
          referencia: attachment.referencia,
          arquivo: attachment.arquivo,
          url: attachment.url,
        }),
      ),
    };

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('contexto-dossie.json', JSON.stringify(input.context, null, 2));
    if (missingOfficialDocuments.length > 0) {
      zip.file(
        'falhas-documentos-oficiais.json',
        JSON.stringify(missingOfficialDocuments, null, 2),
      );
    }

    const filename = `${this.sanitizeBundleBaseName(input.filenameBase)}__${new Date(
      input.generatedAt,
    )
      .toISOString()
      .slice(0, 10)}.zip`;

    return {
      filename,
      buffer: await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      }),
    };
  }

  private sanitizeBundleBaseName(value: string): string {
    return value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .toLowerCase()
      .slice(0, 80);
  }

  private sanitizeBundleFileName(value: string, index: number): string {
    const sanitized = value
      .normalize('NFKD')
      .replace(/[^\w.\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_');

    if (!sanitized) {
      return `documento_${index + 1}.pdf`;
    }

    return `${String(index + 1).padStart(2, '0')}_${sanitized}`;
  }

  private buildEmployeeDossierCode(userId: string): string {
    return this.buildTransitionalDossierCode('employee', userId);
  }

  private buildSiteDossierCode(siteId: string): string {
    return this.buildTransitionalDossierCode('site', siteId);
  }

  private buildLegacyDossierCode(kind: DossierKind, id: string): string {
    const prefix = id.slice(0, 8).toUpperCase();
    return kind === 'employee' ? `DOS-EMP-${prefix}` : `DOS-SIT-${prefix}`;
  }

  private buildTransitionalDossierCode(kind: DossierKind, id: string): string {
    const prefix = id.slice(0, 8).toUpperCase();
    const checksum = createHash('sha256')
      .update(`dossier:${kind}:${id}`)
      .digest('hex')
      .slice(0, 4)
      .toUpperCase();
    return kind === 'employee'
      ? `DOS-EMP-${prefix}${checksum}`
      : `DOS-SIT-${prefix}${checksum}`;
  }

  private async buildGovernedDossierCode(kind: DossierKind): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = kind === 'employee' ? 'DOS-EMP' : 'DOS-SIT';

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const token = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
      const code = `${prefix}-${year}-${token}`;
      const tenantId = this.tenantService.getTenantId();
      const existing = tenantId
        ? await this.documentRegistryService.findByCode(code, tenantId, true)
        : null;
      if (!existing) {
        return code;
      }
    }

    return `${prefix}-${year}-${createHash('sha256')
      .update(randomUUID())
      .digest('hex')
      .slice(0, 12)
      .toUpperCase()}`;
  }

  private getDocumentTypeByKind(kind: DossierKind): string {
    return kind === 'employee'
      ? DOSSIER_EMPLOYEE_DOCUMENT_TYPE
      : DOSSIER_SITE_DOCUMENT_TYPE;
  }

  private getValidationDocumentType(kind: DossierKind): string {
    return kind === 'employee' ? 'employee_dossier' : 'site_dossier';
  }

  private resolveDossierKindFromDocumentType(
    documentType: string | null | undefined,
    code: string,
  ): DossierKind | null {
    const normalized = String(documentType || '')
      .trim()
      .toLowerCase();

    if (
      normalized === DOSSIER_EMPLOYEE_DOCUMENT_TYPE ||
      normalized === 'employee_dossier'
    ) {
      return 'employee';
    }
    if (
      normalized === DOSSIER_SITE_DOCUMENT_TYPE ||
      normalized === 'site_dossier'
    ) {
      return 'site';
    }

    if (code.startsWith('DOS-EMP-')) {
      return 'employee';
    }
    if (code.startsWith('DOS-SIT-')) {
      return 'site';
    }

    return null;
  }

  private extractEmployeeCodePrefix(code: string): string | null {
    const transitional = code.match(DOSSIER_CODE_TRANSITIONAL_EMPLOYEE_REGEX);
    if (transitional) {
      return transitional[1];
    }
    const legacy = code.match(DOSSIER_CODE_LEGACY_EMPLOYEE_REGEX);
    if (legacy) {
      return legacy[1];
    }
    return null;
  }

  private extractSiteCodePrefix(code: string): string | null {
    const transitional = code.match(DOSSIER_CODE_TRANSITIONAL_SITE_REGEX);
    if (transitional) {
      return transitional[1];
    }
    const legacy = code.match(DOSSIER_CODE_LEGACY_SITE_REGEX);
    if (legacy) {
      return legacy[1];
    }
    return null;
  }

  private buildTruncationInfo(
    datasets: DossierDatasetTruncation,
  ): DossierTruncationInfo {
    const truncated = Object.values(datasets).some(Boolean);
    return {
      limit: DOSSIER_RECORD_LIMIT,
      truncated,
      datasets,
    };
  }

  private async attachGovernedPdf(input: {
    kind: DossierKind;
    entityId: string;
    companyId: string;
    title: string;
    documentDate?: Date | string | null;
    file: Express.Multer.File;
    actorId?: string;
  }): Promise<{
    dossierId: string;
    kind: DossierKind;
    hasFinalPdf: boolean;
    availability: DossierPdfAccessAvailability;
    message: string;
    degraded: boolean;
    fileKey: string;
    folderPath: string;
    originalName: string;
    documentCode: string;
    fileHash: string;
  }> {
    const existingRegistry = await this.documentRegistryService.findByDocument(
      'dossier',
      input.entityId,
      this.getDocumentTypeByKind(input.kind),
      input.companyId,
    );

    const originalName =
      input.file.originalname?.trim() ||
      (input.kind === 'employee'
        ? `dossie_colaborador_${input.entityId}.pdf`
        : `dossie_unidade_${input.entityId}.pdf`);
    const fileKey = this.documentStorageService.generateDocumentKey(
      input.companyId,
      `dossiers-${input.kind}`,
      input.entityId,
      originalName,
      {
        folderSegments: input.kind === 'site' ? ['sites', input.entityId] : [],
      },
    );
    const folderPath = fileKey.split('/').slice(0, -1).join('/');

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'dossier', resourceId: input.entityId },
          'p1-document-storage-uploadFile',
        ),
        input.file.buffer,
        input.file.mimetype || 'application/pdf',
      );

    try {
      const documentCode =
        existingRegistry?.document_code ||
        (await this.buildGovernedDossierCode(input.kind));
      const { hash, registryEntry } =
        await this.documentGovernanceService.registerFinalDocument({
          companyId: input.companyId,
          module: 'dossier',
          entityId: input.entityId,
          title: input.title,
          documentDate: input.documentDate || new Date(),
          documentType: this.getDocumentTypeByKind(input.kind),
          fileKey,
          folderPath,
          originalName,
          mimeType: input.file.mimetype || 'application/pdf',
          fileBuffer: input.file.buffer,
          createdBy: input.actorId || null,
          documentCode,
        });

      this.logger.log({
        event: 'dossier_final_pdf_emitted',
        kind: input.kind,
        dossierId: input.entityId,
        companyId: input.companyId,
        keyFingerprint: storageKeyFingerprint(fileKey),
        documentCode: registryEntry.document_code || documentCode,
      });

      if (existingRegistry?.file_key && existingRegistry.file_key !== fileKey) {
        await cleanupUploadedFile(
          this.logger,
          `dossiers.attachGovernedPdf:cleanupPrevious:${input.kind}:${input.entityId}`,
          existingRegistry.file_key,
          (key) =>
            this.documentStorageService.deleteFile(
              this.documentStorageService.referenceForExistingObject(
                key,
                { resourceType: 'dossier', resourceId: input.entityId },
                'p1-document-storage-deleteFile',
              ),
            ),
        );
      }

      return {
        dossierId: input.entityId,
        kind: input.kind,
        hasFinalPdf: true,
        availability: 'ready',
        message: 'PDF final governado do dossie emitido com sucesso.',
        degraded: false,
        fileKey,
        folderPath,
        originalName,
        documentCode: registryEntry.document_code || documentCode,
        fileHash: hash,
      };
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `dossiers.attachGovernedPdf:${input.kind}:${input.entityId}`,
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }
  }

  private async getGovernedPdfAccess(input: {
    kind: DossierKind;
    entityId: string;
    companyId: string;
    fallbackCode: string;
  }): Promise<{
    dossierId: string;
    kind: DossierKind;
    hasFinalPdf: boolean;
    availability: DossierPdfAccessAvailability;
    message: string;
    degraded: boolean;
    fileKey: string | null;
    folderPath: string | null;
    originalName: string | null;
    fileHash: string | null;
    documentCode: string;
    url: string | null;
  }> {
    const registryEntry = await this.documentRegistryService.findByDocument(
      'dossier',
      input.entityId,
      this.getDocumentTypeByKind(input.kind),
      input.companyId,
    );

    if (!registryEntry) {
      return {
        dossierId: input.entityId,
        kind: input.kind,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message:
          'O dossie ainda nao possui PDF final governado emitido. Emita o documento final para habilitar download oficial e validacao forte.',
        degraded: false,
        fileKey: null,
        folderPath: null,
        originalName: null,
        fileHash: null,
        documentCode: input.fallbackCode,
        url: null,
      };
    }

    let availability: DossierPdfAccessAvailability = 'ready';
    let degraded = false;
    let message = 'PDF final governado do dossie disponivel para acesso.';
    let url: string | null = null;

    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          registryEntry.file_key,
          {
            resourceType: 'dossier',
            resourceId: input.entityId,
          },
          'p1-document-storage-getSignedUrl',
        ),
      );
    } catch (error) {
      availability = 'registered_without_signed_url';
      degraded = true;
      message =
        'PDF final registrado, mas a URL segura nao esta disponivel no momento. Tente novamente quando o storage estiver saudavel.';
      this.logger.warn(
        `URL assinada indisponivel para dossie ${input.kind}:${input.entityId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      dossierId: input.entityId,
      kind: input.kind,
      hasFinalPdf: true,
      availability,
      message,
      degraded,
      fileKey: registryEntry.file_key,
      folderPath: registryEntry.folder_path,
      originalName: registryEntry.original_name,
      fileHash: registryEntry.file_hash,
      documentCode: registryEntry.document_code || input.fallbackCode,
      url,
    };
  }

  private async resolveDossierByRegistryCode(code: string): Promise<{
    valid: boolean;
    code: string;
    message?: string;
    document?: {
      id: string;
      module: string;
      document_type: string;
      title: string;
      document_date: string | null;
      original_name: string | null;
      file_hash: string | null;
      updated_at: string;
    };
    final_document?: {
      has_final_pdf: boolean;
      document_code: string | null;
      original_name: string | null;
      file_hash: string | null;
      emitted_at: string | null;
    };
  } | null> {
    const tenantId = this.tenantService.getTenantId();
    const registryEntry = tenantId
      ? await this.documentRegistryService.findByCode(code, tenantId, true)
      : null;
    if (!registryEntry || registryEntry.module !== 'dossier') {
      return null;
    }

    const kind = this.resolveDossierKindFromDocumentType(
      registryEntry.document_type,
      code,
    );
    if (!kind) {
      return null;
    }

    if (kind === 'employee') {
      const user = await this.usersRepository.findOne({
        where: {
          id: registryEntry.entity_id,
          company_id: registryEntry.company_id,
        },
      });
      if (!user) {
        return null;
      }

      return {
        valid: true,
        code,
        document: {
          id: user.id,
          module: 'dossier',
          document_type: this.getValidationDocumentType('employee'),
          title: registryEntry.title || `Dossie do colaborador ${user.nome}`,
          document_date: this.serializeDate(registryEntry.document_date),
          original_name: registryEntry.original_name,
          file_hash: registryEntry.file_hash,
          updated_at:
            this.serializeDate(registryEntry.updated_at) ||
            new Date().toISOString(),
        },
        final_document: {
          has_final_pdf: true,
          document_code: registryEntry.document_code,
          original_name: registryEntry.original_name,
          file_hash: registryEntry.file_hash,
          emitted_at:
            this.serializeDate(registryEntry.created_at) ||
            this.serializeDate(registryEntry.updated_at),
        },
      };
    }

    const site = await this.sitesRepository.findOne({
      where: {
        id: registryEntry.entity_id,
        company_id: registryEntry.company_id,
      },
    });
    if (!site) {
      return null;
    }

    return {
      valid: true,
      code,
      document: {
        id: site.id,
        module: 'dossier',
        document_type: this.getValidationDocumentType('site'),
        title: registryEntry.title || `Dossie da obra/setor ${site.nome}`,
        document_date: this.serializeDate(registryEntry.document_date),
        original_name: registryEntry.original_name,
        file_hash: registryEntry.file_hash,
        updated_at:
          this.serializeDate(registryEntry.updated_at) ||
          new Date().toISOString(),
      },
      final_document: {
        has_final_pdf: true,
        document_code: registryEntry.document_code,
        original_name: registryEntry.original_name,
        file_hash: registryEntry.file_hash,
        emitted_at:
          this.serializeDate(registryEntry.created_at) ||
          this.serializeDate(registryEntry.updated_at),
      },
    };
  }

  private async resolveEmployeeCodeValidation(
    normalizedCode: string,
    prefix: string,
  ): Promise<{
    valid: boolean;
    code: string;
    message?: string;
    document?: {
      id: string;
      module: string;
      document_type: string;
      title: string;
      document_date: string | null;
      original_name: string | null;
      file_hash: string | null;
      updated_at: string;
    };
    final_document?: {
      has_final_pdf: boolean;
      document_code: string | null;
      original_name: string | null;
      file_hash: string | null;
      emitted_at: string | null;
    };
  } | null> {
    const candidate = await this.usersRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.site', 'site')
      .leftJoinAndSelect('user.company', 'company')
      .where('LOWER(user.id) LIKE :prefix', {
        prefix: `${prefix.toLowerCase()}%`,
      })
      .andWhere('user.deleted_at IS NULL')
      .getOne();
    if (!candidate) {
      return null;
    }

    const expectedCode = this.buildEmployeeDossierCode(candidate.id);
    const legacyCode = this.buildLegacyDossierCode('employee', candidate.id);
    if (normalizedCode !== expectedCode && normalizedCode !== legacyCode) {
      return null;
    }

    const registryEntry = await this.documentRegistryService.findByDocument(
      'dossier',
      candidate.id,
      DOSSIER_EMPLOYEE_DOCUMENT_TYPE,
      candidate.company_id,
    );

    return {
      valid: true,
      code: normalizedCode,
      document: {
        id: candidate.id,
        module: 'dossier',
        document_type: this.getValidationDocumentType('employee'),
        title: `Dossie do colaborador ${candidate.nome}`,
        document_date: this.serializeDate(registryEntry?.document_date) || null,
        original_name: registryEntry?.original_name || null,
        file_hash: registryEntry?.file_hash || null,
        updated_at:
          this.serializeDate(
            registryEntry?.updated_at || candidate.updated_at,
          ) || new Date().toISOString(),
      },
      final_document: {
        has_final_pdf: Boolean(registryEntry?.file_key),
        document_code: registryEntry?.document_code || expectedCode,
        original_name: registryEntry?.original_name || null,
        file_hash: registryEntry?.file_hash || null,
        emitted_at: this.serializeDate(registryEntry?.created_at) || null,
      },
    };
  }

  private async resolveSiteCodeValidation(
    normalizedCode: string,
    prefix: string,
  ): Promise<{
    valid: boolean;
    code: string;
    message?: string;
    document?: {
      id: string;
      module: string;
      document_type: string;
      title: string;
      document_date: string | null;
      original_name: string | null;
      file_hash: string | null;
      updated_at: string;
    };
    final_document?: {
      has_final_pdf: boolean;
      document_code: string | null;
      original_name: string | null;
      file_hash: string | null;
      emitted_at: string | null;
    };
  } | null> {
    const candidate = await this.sitesRepository
      .createQueryBuilder('site')
      .leftJoinAndSelect('site.company', 'company')
      .where('LOWER(site.id) LIKE :prefix', {
        prefix: `${prefix.toLowerCase()}%`,
      })
      .andWhere('site.deleted_at IS NULL')
      .getOne();
    if (!candidate) {
      return null;
    }

    const expectedCode = this.buildSiteDossierCode(candidate.id);
    const legacyCode = this.buildLegacyDossierCode('site', candidate.id);
    if (normalizedCode !== expectedCode && normalizedCode !== legacyCode) {
      return null;
    }

    const registryEntry = await this.documentRegistryService.findByDocument(
      'dossier',
      candidate.id,
      DOSSIER_SITE_DOCUMENT_TYPE,
      candidate.company_id,
    );

    return {
      valid: true,
      code: normalizedCode,
      document: {
        id: candidate.id,
        module: 'dossier',
        document_type: this.getValidationDocumentType('site'),
        title: `Dossie da obra/setor ${candidate.nome}`,
        document_date: this.serializeDate(registryEntry?.document_date) || null,
        original_name: registryEntry?.original_name || null,
        file_hash: registryEntry?.file_hash || null,
        updated_at:
          this.serializeDate(
            registryEntry?.updated_at || candidate.updated_at,
          ) || new Date().toISOString(),
      },
      final_document: {
        has_final_pdf: Boolean(registryEntry?.file_key),
        document_code: registryEntry?.document_code || expectedCode,
        original_name: registryEntry?.original_name || null,
        file_hash: registryEntry?.file_hash || null,
        emitted_at: this.serializeDate(registryEntry?.created_at) || null,
      },
    };
  }

  private serializeDate(value?: Date | string | null): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
}
