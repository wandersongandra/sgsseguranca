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

@Entity('notifications')
@Index('IDX_notifications_company_created', ['company_id', 'createdAt'])
@Index('IDX_notifications_user_created', ['userId', 'createdAt'])
@Index('IDX_notifications_user_read', ['userId', 'read'])
@Index('IDX_notifications_user_type_title_created', [
  'userId',
  'type',
  'title',
  'createdAt',
])
@Index(
  'UQ_notifications_company_user_dedupe_active',
  ['company_id', 'userId', 'dedupeKey'],
  {
    unique: true,
    where: '"dedupe_key" IS NOT NULL AND "deleted_at" IS NULL',
  },
)
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @Column({ type: 'uuid' })
  company_id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column()
  type: string; // 'info', 'success', 'warning', 'error'

  @Column()
  title: string;

  @Column('text')
  message: string;

  @Column('jsonb', { nullable: true })
  data: Record<string, unknown>;

  @Column({
    name: 'dedupe_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  dedupeKey: string | null;

  @Column({ default: false })
  read: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: true })
  readAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt: Date | null;
}
