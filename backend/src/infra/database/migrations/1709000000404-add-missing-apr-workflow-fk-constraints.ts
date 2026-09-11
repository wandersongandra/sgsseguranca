import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FKs ausentes identificadas na auditoria do módulo APR (Onda 1).
 * Mesmo padrão já usado pela migration 342 para apr_approval_records.aprId.
 *
 * NOT VALID + VALIDATE CONSTRAINT em `aprs` (tabela com volume real de
 * produção): o ADD CONSTRAINT em si é rápido (ACCESS EXCLUSIVE breve só
 * para registrar metadado); o VALIDATE roda depois com lock mais brando
 * (SHARE UPDATE EXCLUSIVE), sem bloquear leituras/escritas concorrentes.
 * ISSO SÓ VALE se ADD CONSTRAINT e VALIDATE CONSTRAINT rodarem em
 * transações SEPARADAS — daí `transaction = false` abaixo (achado da
 * auditoria v2: sem isso o TypeORM embrulha up() inteiro numa única
 * transação, e o lock ACCESS EXCLUSIVE do ADD CONSTRAINT fica retido até
 * o COMMIT final, ou seja, durante o VALIDATE inteiro — exatamente o
 * bloqueio que este padrão existe para evitar. Mesmo padrão que a
 * migration 342 já usa corretamente).
 *
 * As UPDATEs de remediação abaixo (antes de cada ADD CONSTRAINT) evitam
 * que o deploy falhe caso já existam referências órfãs — tanto em
 * aprs.workflowConfigId quanto em apr_workflow_configs.tenantId/siteId
 * (tabela pequena, da feature de workflow configurável hoje desativada,
 * que foi populada por um seed/controller já removidos e pode apontar
 * para empresas/obras excluídas desde então).
 */
export class AddMissingAprWorkflowForeignKeys1709000000404 implements MigrationInterface {
  name = 'AddMissingAprWorkflowForeignKeys1709000000404';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "aprs" SET "workflowConfigId" = NULL
      WHERE "workflowConfigId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "apr_workflow_configs" c WHERE c.id = "aprs"."workflowConfigId"
        )
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_aprs_workflow_config_id'
        ) THEN
          ALTER TABLE "aprs"
            ADD CONSTRAINT "FK_aprs_workflow_config_id"
            FOREIGN KEY ("workflowConfigId") REFERENCES "apr_workflow_configs"("id")
            ON DELETE SET NULL
            NOT VALID;
        END IF;
      END;
      $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "aprs" VALIDATE CONSTRAINT "FK_aprs_workflow_config_id"
    `);

    await queryRunner.query(`
      UPDATE "apr_workflow_configs" SET "tenantId" = NULL
      WHERE "tenantId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "companies" c WHERE c.id = "apr_workflow_configs"."tenantId")
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_apr_workflow_configs_tenant_id'
        ) THEN
          ALTER TABLE "apr_workflow_configs"
            ADD CONSTRAINT "FK_apr_workflow_configs_tenant_id"
            FOREIGN KEY ("tenantId") REFERENCES "companies"("id")
            ON DELETE CASCADE;
        END IF;
      END;
      $$;
    `);

    await queryRunner.query(`
      UPDATE "apr_workflow_configs" SET "siteId" = NULL
      WHERE "siteId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "sites" s WHERE s.id = "apr_workflow_configs"."siteId")
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_apr_workflow_configs_site_id'
        ) THEN
          ALTER TABLE "apr_workflow_configs"
            ADD CONSTRAINT "FK_apr_workflow_configs_site_id"
            FOREIGN KEY ("siteId") REFERENCES "sites"("id")
            ON DELETE SET NULL;
        END IF;
      END;
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "apr_workflow_configs" DROP CONSTRAINT IF EXISTS "FK_apr_workflow_configs_site_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "apr_workflow_configs" DROP CONSTRAINT IF EXISTS "FK_apr_workflow_configs_tenant_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "aprs" DROP CONSTRAINT IF EXISTS "FK_aprs_workflow_config_id"
    `);
  }
}
