import {
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Column,
  VersionColumn,
  ManyToOne,
  JoinColumn,
  ManyToMany,
  JoinTable,
} from 'typeorm';
import { BaseAuditEntity } from '../../../shared/entities/base-audit.entity';
import { Company } from '../../companies/entities/company.entity';
import { Site } from '../../sites/entities/site.entity';
import { User } from '../../users/entities/user.entity';

export enum DdsStatus {
  RASCUNHO = 'rascunho',
  PUBLICADO = 'publicado',
  AUDITADO = 'auditado',
  ARQUIVADO = 'arquivado',
}

export enum AuditResult {
  CONFORME = 'Conforme',
  NAO_CONFORME = 'Não Conforme',
  OBSERVACAO = 'Observação',
}

export const DDS_ALLOWED_TRANSITIONS: Record<DdsStatus, DdsStatus[]> = {
  [DdsStatus.RASCUNHO]: [DdsStatus.PUBLICADO, DdsStatus.ARQUIVADO],
  // AUDITADO é gravado pelo fluxo de aprovação (DdsApprovalService.approveStep) — declara aqui
  // para que updateStatus() também aceite a transição via API direta (SGS-DDS-SM-007).
  [DdsStatus.PUBLICADO]: [DdsStatus.AUDITADO, DdsStatus.ARQUIVADO],
  [DdsStatus.AUDITADO]: [DdsStatus.ARQUIVADO],
  [DdsStatus.ARQUIVADO]: [],
};

@Index('IDX_dds_company_created', ['company_id', 'created_at'])
@Entity('dds')
export class Dds extends BaseAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tema: string;

  @Column({ type: 'text', nullable: true })
  conteudo: string;

  @Column({ type: 'date' })
  data: Date;

  @Column({ default: false })
  is_modelo: boolean;

  @ManyToOne(() => Company)
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @Column()
  company_id: string;

  @ManyToOne(() => Site, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'site_id' })
  site: Site | null;

  @Column({ type: 'uuid', nullable: true })
  site_id: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'facilitador_id' })
  facilitador: User;

  @Column()
  facilitador_id: string;

  @ManyToMany(() => User)
  @JoinTable({
    name: 'dds_participants',
    joinColumn: { name: 'dds_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'user_id', referencedColumnName: 'id' },
  })
  participants: User[];

  participant_count?: number;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'auditado_por_id' })
  auditado_por: User;

  @Column({ nullable: true })
  auditado_por_id: string | null;

  @Column({ type: 'timestamp', nullable: true })
  data_auditoria: Date;

  @Column({ type: 'varchar', nullable: true, enum: AuditResult })
  resultado_auditoria: AuditResult | null;

  @Column({ type: 'text', nullable: true })
  notas_auditoria: string;

  @Column({ type: 'text', nullable: true })
  photo_reuse_justification: string | null;

  @Column({ type: 'text', nullable: true })
  pdf_file_key: string;

  @Column({ type: 'text', nullable: true })
  pdf_folder_path: string;

  @Column({ type: 'text', nullable: true })
  pdf_original_name: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  document_code: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  final_pdf_hash_sha256: string | null;

  @Column({ type: 'timestamp', nullable: true })
  pdf_generated_at: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'emitted_by_user_id' })
  emitted_by: User | null;

  @Column({ type: 'uuid', nullable: true })
  emitted_by_user_id: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  emitted_ip: string | null;

  @Column({ type: 'text', nullable: true })
  emitted_user_agent: string | null;

  @Column({
    type: 'varchar',
    default: DdsStatus.RASCUNHO,
    enum: DdsStatus,
  })
  status: DdsStatus;

  @VersionColumn()
  version: number;
}
