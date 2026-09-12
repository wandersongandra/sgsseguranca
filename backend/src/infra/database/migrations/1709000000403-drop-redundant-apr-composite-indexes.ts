import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Continuação da limpeza de índices duplicados da migration 350, que cobriu
 * só os single-column de `aprs`. Os 3 índices abaixo (todos da migration 068,
 * sem predicado parcial) muito provavelmente pararam de ser usados depois que
 * 131/161 introduziram equivalentes company_id-leading com
 * `WHERE deleted_at IS NULL` — que é o filtro presente em 100% das queries de
 * listagem confirmadas em aprs.service.ts#findPaginated.
 *
 * SEGURANÇA: sem acesso à produção nesta auditoria, a migration NÃO assume
 * que estão mortos. Ela:
 *   1. Exige um piso mínimo de atividade na tabela (seq_scan+idx_scan >= 5000)
 *      antes de concluir qualquer coisa — evita agir sobre estatísticas
 *      recém-zeradas por um compute Neon que acabou de subir.
 *   2. Só derruba o índice se idx_scan = 0 nesse cenário; caso contrário
 *      preserva e registra RAISE NOTICE para reavaliação manual.
 *
 * Antes de aplicar em produção, rode manualmente no Neon console:
 *   SELECT indexrelname, idx_scan
 *   FROM pg_stat_user_indexes
 *   WHERE relname = 'aprs'
 *     AND indexrelname IN
 *       ('IDX_aprs_company_created','IDX_aprs_status_company','IDX_aprs_site_company');
 */
export class DropRedundantAprCompositeIndexes1709000000403 implements MigrationInterface {
  name = 'DropRedundantAprCompositeIndexes1709000000403';
  transaction = false;

  private readonly candidates = [
    'IDX_aprs_company_created',
    'IDX_aprs_status_company',
    'IDX_aprs_site_company',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const trafficRows = (await queryRunner.query(`
      SELECT (seq_scan + idx_scan) AS total_reads
      FROM pg_stat_user_tables
      WHERE schemaname = 'public' AND relname = 'aprs'
    `)) as Array<{ total_reads: string | number }>;
    const totalReads = Number(trafficRows[0]?.total_reads ?? 0);

    if (totalReads < 5000) {
      await queryRunner.query(`
        DO $$ BEGIN
          RAISE NOTICE '0403: aprs com apenas % leituras registradas — piso de segurança não atingido, nenhum índice removido nesta execução', ${totalReads};
        END $$;
      `);
      return;
    }

    for (const indexName of this.candidates) {
      const rows = (await queryRunner.query(
        `
          SELECT idx_scan
          FROM pg_stat_user_indexes
          WHERE schemaname = 'public'
            AND relname = 'aprs'
            AND indexrelname = $1
        `,
        [indexName],
      )) as Array<{ idx_scan: string | number }>;

      if (rows.length === 0) continue;

      const scans = Number(rows[0].idx_scan ?? 0);
      if (scans > 0) {
        await queryRunner.query(`
          DO $$ BEGIN
            RAISE NOTICE '0403: % preservado — idx_scan=% (uso detectado)', '${indexName}', ${scans};
          END $$;
        `);
        continue;
      }

      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_aprs_company_created"
      ON "aprs" ("company_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_aprs_status_company"
      ON "aprs" ("status", "company_id")
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_aprs_site_company"
      ON "aprs" ("site_id", "company_id")
    `);
  }
}
