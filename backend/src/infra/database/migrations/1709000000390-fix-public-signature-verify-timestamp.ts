import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corrige o contrato SQL da função pública de verificação de assinatura.
 *
 * `signatures.signed_at` é `timestamp without time zone`, enquanto a função
 * declara `timestamptz`. Sem o cast explícito, qualquer hash localizado faz o
 * PostgreSQL rejeitar o RETURN QUERY por incompatibilidade de tipos.
 */
export class FixPublicSignatureVerifyTimestamp1709000000390 implements MigrationInterface {
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
        IF NOT (p_hash ~ '^[a-f0-9]{64}$') THEN
          RETURN;
        END IF;

        RETURN QUERY
        SELECT
          s.signature_hash::TEXT,
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
  }

  public down(queryRunner: QueryRunner): Promise<void> {
    // A migration de correção não remove a função criada pelo contrato base.
    // O down é deliberadamente no-op para preservar rollback seguro.
    void queryRunner;
    return Promise.resolve();
  }
}
