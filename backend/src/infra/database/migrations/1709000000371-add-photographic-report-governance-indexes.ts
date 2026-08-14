import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índices de governança e integridade do Relatório Fotográfico.
 *
 * Separada da 370 porque `CREATE INDEX CONCURRENTLY` não pode rodar dentro de
 * uma transação — daí `transaction = false`.
 *
 * ÍNDICE 1 — unicidade do código de validação
 *   `verification_code` é o código impresso no PDF e no QR, resolvido depois
 *   por `documentRegistryService.validatePublicCode({ code, companyId })`.
 *   Como a resolução é por (código, empresa), a unicidade é escopada por
 *   `company_id`: exigir unicidade global seria uma restrição mais forte do que
 *   a consulta precisa e poderia recusar um insert legítimo de outro tenant.
 *   Parcial em `deleted_at IS NULL`, seguindo a convenção já estabelecida em
 *   1709000000348 — um relatório excluído não deve reservar o código.
 *
 * ÍNDICE 2 — busca por hash de evidência
 *   Existe para que uma verificação pública por hash (como a que a APR já expõe
 *   em GET /public/evidence/verify) possa ser atendida sem seq scan. O endpoint
 *   NÃO é criado aqui: está fora do escopo aprovado. O índice é barato e evita
 *   que a decisão futura exija outra migration com CONCURRENTLY em tabela já
 *   grande.
 *
 * RISCO OPERACIONAL
 *   Se um CREATE INDEX CONCURRENTLY falhar no meio, o Postgres deixa um índice
 *   INVÁLIDO. `IF NOT EXISTS` enxerga o índice inválido como existente e NÃO o
 *   reconstrói — nesse caso é preciso derrubá-lo manualmente antes de reexecutar.
 */
export class AddPhotographicReportGovernanceIndexes1709000000371 implements MigrationInterface {
  name = 'AddPhotographicReportGovernanceIndexes1709000000371';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      (await queryRunner.hasTable('photographic_reports')) &&
      (await queryRunner.hasColumn('photographic_reports', 'verification_code'))
    ) {
      await queryRunner.query(`
        CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
          "UQ_photographic_reports_company_verification_code"
        ON "photographic_reports" ("company_id", "verification_code")
        WHERE "verification_code" IS NOT NULL AND "deleted_at" IS NULL
      `);
    }

    if (
      (await queryRunner.hasTable('photographic_report_images')) &&
      (await queryRunner.hasColumn('photographic_report_images', 'hash_sha256'))
    ) {
      await queryRunner.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS
          "IDX_photographic_report_images_hash_sha256"
        ON "photographic_report_images" ("hash_sha256")
        WHERE "hash_sha256" IS NOT NULL
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS
        "IDX_photographic_report_images_hash_sha256"
    `);
    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS
        "UQ_photographic_reports_company_verification_code"
    `);
  }
}
