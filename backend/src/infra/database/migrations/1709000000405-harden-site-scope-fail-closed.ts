import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mantém o escopo de obra fechado quando uma conexão não recebeu contexto
 * completo. A migration 0127 tratava configuração ausente ou inválida como
 * `all`, o que podia ampliar a leitura de todas as obras do tenant.
 */
export class HardenSiteScopeFailClosed1709000000405 implements MigrationInterface {
  name = 'HardenSiteScopeFailClosed1709000000405';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      queryRunner.connection.options.type === 'sqlite' ||
      queryRunner.connection.options.type === 'better-sqlite3'
    ) {
      return;
    }

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.current_site_scope()
      RETURNS text AS $$
      DECLARE
        scope_value text;
      BEGIN
        scope_value := lower(btrim(current_setting('app.current_site_scope', true)));

        IF scope_value = 'all' THEN
          RETURN 'all';
        END IF;

        IF scope_value = 'single' THEN
          RETURN 'single';
        END IF;

        -- Ausência ou valor desconhecido nunca pode ampliar o escopo.
        RETURN 'single';
      EXCEPTION
        WHEN others THEN
          RETURN 'single';
      END;
      $$ LANGUAGE plpgsql STABLE
         SET search_path = public;
    `);
  }

  public async down(): Promise<void> {
    // Não reintroduzir o fallback inseguro da migration histórica.
  }
}
