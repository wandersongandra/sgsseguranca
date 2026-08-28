import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove capacidades de DDL relacional do runtime e a mutação do ledger de
 * migrations sem remover o SELECT usado pelo versionamento de backups.
 *
 * O down permanece seguro: reintroduzir REFERENCES, TRIGGER ou escrita no
 * ledger durante um rollback reabriria findings de least-privilege.
 */
export class RestrictRuntimeDatabasePrivileges1709000000398 implements MigrationInterface {
  name = 'RestrictRuntimeDatabasePrivileges1709000000398';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      REVOKE REFERENCES, TRIGGER
        ON ALL TABLES IN SCHEMA public
        FROM sgs_app
    `);

    await queryRunner.query(`
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON TABLE public."migrations"
        FROM sgs_app
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        owner_role text;
      BEGIN
        FOREACH owner_role IN ARRAY ARRAY['sgs_migrator', 'neondb_owner'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role) THEN
            EXECUTE format(
              'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE REFERENCES, TRIGGER ON TABLES FROM sgs_app',
              owner_role
            );
          END IF;
        END LOOP;
      END
      $$
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // A security migration must not reintroduce the privileges it removes.
  }
}
