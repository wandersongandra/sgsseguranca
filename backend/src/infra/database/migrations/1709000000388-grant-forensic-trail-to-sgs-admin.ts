import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permite que a conexão privilegiada persista a trilha forense sem reabrir o
 * bypass de RLS para a conexão comum da aplicação.
 */
export class GrantForensicTrailToSgsAdmin1709000000388 implements MigrationInterface {
  name = 'GrantForensicTrailToSgsAdmin1709000000388';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin')
           AND to_regclass('public.forensic_trail_events') IS NOT NULL THEN
          GRANT INSERT, SELECT ON TABLE public.forensic_trail_events TO sgs_admin;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin')
           AND to_regclass('public.forensic_trail_events') IS NOT NULL THEN
          REVOKE INSERT, SELECT ON TABLE public.forensic_trail_events FROM sgs_admin;
        END IF;
      END $$;
    `);
  }
}
