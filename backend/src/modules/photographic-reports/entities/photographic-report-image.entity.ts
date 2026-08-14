import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BaseAuditEntity } from '../../../shared/entities/base-audit.entity';
import { Company } from '../../companies/entities/company.entity';
import { PhotographicReport } from './photographic-report.entity';
import { PhotographicReportDay } from './photographic-report-day.entity';

@Entity('photographic_report_images')
@Index('IDX_photographic_report_images_report_order', [
  'report_id',
  'image_order',
])
export class PhotographicReportImage extends BaseAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Company)
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @Column({ type: 'uuid' })
  company_id: string;

  @ManyToOne(() => PhotographicReport, (report) => report.images, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'report_id' })
  report: PhotographicReport;

  @Column({ type: 'uuid' })
  report_id: string;

  @ManyToOne(() => PhotographicReportDay, (day) => day.images, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'report_day_id' })
  reportDay?: PhotographicReportDay | null;

  @Column({ type: 'uuid', nullable: true })
  report_day_id: string | null;

  @Column({ type: 'text' })
  image_url: string;

  @Column({ type: 'integer', default: 1 })
  image_order: number;

  @Column({ type: 'text', nullable: true })
  manual_caption: string | null;

  @Column({ type: 'text', nullable: true })
  ai_title: string | null;

  @Column({ type: 'text', nullable: true })
  ai_description: string | null;

  @Column({ type: 'jsonb', nullable: true })
  ai_positive_points: string[] | null;

  @Column({ type: 'text', nullable: true })
  ai_technical_assessment: string | null;

  @Column({ type: 'text', nullable: true })
  ai_condition_classification: string | null;

  @Column({ type: 'jsonb', nullable: true })
  ai_recommendations: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  photo_conditions: string[] | null;

  // ── Não conformidade ──────────────────────────────────────────────────────
  // Uma foto classificada como "Atenção necessária" não gerava nenhum item
  // acionável. Estes campos transformam a evidência visual em pendência com
  // dono e prazo, e alimentam o resumo de não conformidades no PDF.

  @Column({ type: 'boolean', default: false })
  is_nonconformity: boolean;

  @Column({ type: 'text', nullable: true })
  recommended_action: string | null;

  /**
   * `date` é mantido como string (igual a `start_date` no relatório) para não
   * sofrer deslocamento de fuso ao atravessar Date.
   */
  @Column({ type: 'date', nullable: true })
  action_deadline: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  action_responsible: string | null;

  // ── Integridade da evidência ──────────────────────────────────────────────
  // Espelha o conjunto de `apr_risk_evidences`. Preenchido no upload por
  // shared/security/evidence-integrity.util.ts; nulo em linhas anteriores à
  // migration 1709000000370.

  @Column({ type: 'text', nullable: true })
  original_name: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  mime_type: string | null;

  @Column({ type: 'integer', nullable: true })
  file_size_bytes: number | null;

  /**
   * SHA-256 dos bytes recebidos. Não prova autoria da captura: o frontend
   * re-encoda a imagem via canvas antes do envio (ver `integrity_flags`).
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  hash_sha256: string | null;

  @Column({ type: 'timestamp', nullable: true })
  captured_at: Date | null;

  // O driver pg devolve `numeric` como string. Sem o transformer, quem formata
  // coordenada recebe "-23.5600000" onde espera número e quebra em silêncio.
  @Column({
    type: 'numeric',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value == null ? null : Number(value)),
    },
  })
  latitude: number | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value == null ? null : Number(value)),
    },
  })
  longitude: number | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value == null ? null : Number(value)),
    },
  })
  accuracy_m: number | null;

  /** HMAC-SHA256 do identificador de dispositivo — o valor cru nunca é gravado. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  device_id: string | null;

  /** IP mascarado: IPv4 em /24, IPv6 em /48. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  ip_address: string | null;

  @Column({ type: 'timestamp', nullable: true })
  exif_datetime: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  integrity_flags: Record<string, unknown> | null;
}
