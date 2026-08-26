import { MigrationInterface, QueryRunner } from 'typeorm';

/** Permite validar o tenant por conexão privilegiada sem elevar sgs_app. */
export class GrantTenantValidationToSgsAdmin1709000000389 implements MigrationInterface {
  name = 'GrantTenantValidationToSgsAdmin1709000000389';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin')
           AND to_regclass('public.companies') IS NOT NULL THEN
          GRANT SELECT ON TABLE public.companies TO sgs_admin;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgs_admin')
           AND to_regclass('public.companies') IS NOT NULL THEN
          REVOKE SELECT ON TABLE public.companies FROM sgs_admin;
        END IF;
      END $$;
    `);
  }
}
