import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BaseAuditEntity } from '../../../shared/entities/base-audit.entity';
import { Company } from '../../companies/entities/company.entity';
import type { PhotographicReportRegistrationType } from '../photographic-reports.constants';
import { PhotographicReportDay } from './photographic-report-day.entity';
import { PhotographicReportImage } from './photographic-report-image.entity';
import { PhotographicReportExport } from './photographic-report-export.entity';

export enum PhotographicReportStatus {
  RASCUNHO = 'Rascunho',
  AGUARDANDO_FOTOS = 'Aguardando fotos',
  AGUARDANDO_ANALISE = 'Aguardando análise',
  ANALISADO = 'Analisado',
  EM_EDICAO = 'Em edição',
  FINALIZADO = 'Finalizado',
  EXPORTADO = 'Exportado',
  CANCELADO = 'Cancelado',
}

export enum PhotographicReportTone {
  POSITIVO = 'Positivo',
  TECNICO = 'Técnico',
  PREVENTIVO = 'Preventivo',
}

export enum PhotographicReportAreaStatus {
  LOJA_ABERTA = 'Loja aberta',
  LOJA_FECHADA = 'Loja fechada',
  AREA_CONTROLADA = 'Área controlada',
  AREA_ISOLADA = 'Área isolada',
}

export enum PhotographicReportShift {
  DIURNO = 'Diurno',
  NOTURNO = 'Noturno',
  INTEGRAL = 'Integral',
}

@Entity('photographic_reports')
@Index('IDX_photographic_reports_company_created', ['company_id', 'created_at'])
@Index('IDX_photographic_reports_company_status', ['company_id', 'status'])
export class PhotographicReport extends BaseAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Company)
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @Column({ type: 'uuid' })
  company_id: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  client_id: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  project_id: string | null;

  @Column({ type: 'varchar', length: 160 })
  client_name: string;

  @Column({ type: 'varchar', length: 160 })
  project_name: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  unit_name: string | null;

  @Column({ type: 'varchar', length: 220, nullable: true })
  location: string | null;

  @Column({ type: 'varchar', length: 120 })
  activity_type: string;

  @Column({
    type: 'enum',
    enum: PhotographicReportTone,
    default: PhotographicReportTone.POSITIVO,
  })
  report_tone: PhotographicReportTone;

  @Column({
    type: 'enum',
    enum: PhotographicReportAreaStatus,
    default: PhotographicReportAreaStatus.LOJA_ABERTA,
  })
  area_status: PhotographicReportAreaStatus;

  @Column({
    type: 'enum',
    enum: PhotographicReportShift,
    default: PhotographicReportShift.DIURNO,
  })
  shift: PhotographicReportShift;

  @Column({ type: 'date' })
  start_date: string;

  @Column({ type: 'date', nullable: true })
  end_date: string | null;

  @Column({ type: 'time' })
  start_time: string;

  @Column({ type: 'time' })
  end_time: string;

  @Column({ type: 'varchar', length: 160 })
  responsible_name: string;

  // ── Credencial do responsável técnico ─────────────────────────────────────
  // Um relatório técnico de SST é julgado pelo registro profissional de quem
  // assina. Sem estes campos o documento é apenas um álbum de fotos.

  @Column({ type: 'varchar', length: 12, nullable: true })
  responsible_registration_type: PhotographicReportRegistrationType | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  responsible_registration_number: string | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  responsible_registration_state: string | null;

  /** Anotação de Responsabilidade Técnica, quando houver. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  art_number: string | null;

  @Column({ type: 'varchar', length: 180 })
  contractor_company: string;

  // ── Escopo normativo e método ─────────────────────────────────────────────

  /** NRs aplicáveis, validadas contra APPLICABLE_NR_OPTIONS no serviço. */
  @Column({ type: 'jsonb', nullable: true })
  applicable_nrs: string[] | null;

  @Column({ type: 'text', nullable: true })
  inspection_methodology: string | null;

  @Column({ type: 'text', nullable: true })
  scope_and_limitations: string | null;

  @Column({ type: 'text', nullable: true })
  general_observations: string | null;

  @Column({ type: 'text', nullable: true })
  ai_summary: string | null;

  @Column({ type: 'text', nullable: true })
  final_conclusion: string | null;

  @Column({
    type: 'enum',
    enum: PhotographicReportStatus,
    default: PhotographicReportStatus.RASCUNHO,
  })
  status: PhotographicReportStatus;

  // ── Governança do documento emitido ───────────────────────────────────────
  // Escritos EXCLUSIVAMENTE pelo backend, dentro da transação de
  // registerFinalDocument. Nunca aceitos no payload — os DTOs os rejeitam.

  /** Código público impresso no PDF e no QR (RFP-<ano>-<8>). */
  @Column({ type: 'varchar', length: 24, nullable: true })
  verification_code: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  final_pdf_hash_sha256: string | null;

  @Column({ type: 'text', nullable: true })
  pdf_file_key: string | null;

  @Column({ type: 'text', nullable: true })
  pdf_folder_path: string | null;

  @Column({ type: 'text', nullable: true })
  pdf_original_name: string | null;

  @Column({ type: 'timestamp', nullable: true })
  pdf_generated_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  created_by: string | null;

  @OneToMany(() => PhotographicReportDay, (day) => day.report)
  days?: PhotographicReportDay[];

  @OneToMany(() => PhotographicReportImage, (image) => image.report)
  images?: PhotographicReportImage[];

  @OneToMany(() => PhotographicReportExport, (exportItem) => exportItem.report)
  exports?: PhotographicReportExport[];
}
