import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cria a função SECURITY DEFINER `verify_signature_by_hash_public` para
 * permitir que a rota pública GET /public/signature/verify consulte a tabela
 * `signatures` sem contexto de tenant.
 *
 * Problema: a tabela `signatures` tem FORCE ROW LEVEL SECURITY com política
 * `site_scope_isolation_policy` que exige `company_id = current_company()`.
 * Em rotas públicas (sem JWT nem x-company-id), `current_company()` retorna
 * NULL, bloqueando 100% das linhas.
 *
 * Solução: função SECURITY DEFINER que roda como o role proprietário (com
 * BYPASSRLS implícito), filtrada estritamente por hash SHA-256 e retornando
 * apenas metadados de prova (sem PII).
 *
 * Segurança:
 *   - Valida formato do hash antes de qualquer SELECT (regex ^[a-f0-9]{64}$)
 *   - Retorna somente colunas de prova técnica — sem user_id, CPF, dados de
 *     identificação pessoal, ou conteúdo de documento
 *   - deleted_at IS NULL garante que registros excluídos permaneçam ocultos
 *   - LIMIT 1 evita table scan completo
 *   - SET search_path previne search_path injection
 *   - GRANT EXECUTE apenas para o role de runtime (sgs_app)
 */
export class AddPublicSignatureVerifyFunction1709000000383 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION verify_signature_by_hash_public(p_hash TEXT)
      RETURNS TABLE (
        signature_hash      TEXT,
        signed_at           TIMESTAMPTZ,
        timestamp_authority TEXT,
        type                TEXT,
        timestamp_token     TEXT,
        integrity_payload   JSONB
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $$
      BEGIN
        -- Rejeita hashes malformados antes de qualquer acesso à tabela
        IF NOT (p_hash ~ '^[a-f0-9]{64}$') THEN
          RETURN;
        END IF;

        RETURN QUERY
        SELECT
          s.signature_hash::TEXT,
          -- signatures.signed_at é timestamp sem timezone; o contrato público
          -- da função é timestamptz. A conversão explícita mantém o contrato
          -- estável em PostgreSQL e evita erro de tipo no RETURN QUERY.
          s.signed_at AT TIME ZONE 'UTC',
          s.timestamp_authority::TEXT,
          s.type::TEXT,
          s.timestamp_token::TEXT,
          s.integrity_payload
        FROM signatures s
        WHERE s.signature_hash = p_hash
          AND s.deleted_at IS NULL
        LIMIT 1;
      END;
      $$
    `);

    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION verify_signature_by_hash_public(TEXT) TO sgs_app
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION verify_signature_by_hash_public(TEXT) FROM sgs_app
    `);

    await queryRunner.query(`
      DROP FUNCTION IF EXISTS verify_signature_by_hash_public(TEXT)
    `);
  }
}
