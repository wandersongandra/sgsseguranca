import {
  Index,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Company } from '../../companies/entities/company.entity';
import { Site } from '../../sites/entities/site.entity';
import { User } from '../../users/entities/user.entity';

@Entity('signatures')
@Index('IDX_signatures_document_type_document_id', [
  'document_type',
  'document_id',
])
export class Signature {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Company, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @Column({ type: 'uuid' })
  company_id: string;

  @ManyToOne(() => Site, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'site_id' })
  site?: Site | null;

  @Column({ type: 'uuid', nullable: true })
  site_id: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column()
  user_id: string;

  @Column()
  document_id: string;

  @Column()
  document_type: string; // 'DDS', 'APR', etc.

  @Column({ type: 'text', nullable: true })
  signature_data: string | null; // base64/hmac string; null when offloaded to S3

  @Column({ type: 'varchar', length: 512, nullable: true })
  signature_data_key: string | null; // S3 key when signature_data was offloaded

  @Column()
  type: string; // 'digital', 'upload', 'facial'

  @Column({ nullable: true })
  signature_hash?: string;

  @Column({ nullable: true })
  timestamp_token?: string;

  @Column({ nullable: true })
  timestamp_authority?: string;

  @Column({ type: 'timestamp', nullable: true })
  signed_at?: Date;

  @Column({ type: 'jsonb', nullable: true })
  integrity_payload?: Record<string, unknown>;

  /** Hash do conteúdo semântico protegido; nulo em assinaturas legadas. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  content_hash?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  hash_algorithm?: string | null;

  @Column({ type: 'int', nullable: true })
  canonicalization_version?: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  integrity_scheme?: string | null;

  @CreateDateColumn()
  created_at: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at?: Date | null;
}
