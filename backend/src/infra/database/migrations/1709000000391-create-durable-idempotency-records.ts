import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-006: Redis é fast-path, não o registro durável de uma operação.
 *
 * A tabela não guarda a chave bruta nem o escopo bruto: ambos são hashes
 * vinculados ao método e ao path. A resposta limitada é persistida somente
 * para permitir replay sem repetir o efeito de domínio.
 */
export class CreateDurableIdempotencyRecords1709000000391 implements MigrationInterface {
  name = 'CreateDurableIdempotencyRecords1709000000391';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "idempotency_durable_records" (
        "id" uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
        "scope_hash" character varying(64) NOT NULL,
        "method" character varying(16) NOT NULL,
        "path" character varying(512) NOT NULL,
        "idempotency_key_hash" character varying(64) NOT NULL,
        "request_hash" character varying(64) NOT NULL,
        "status" character varying(16) NOT NULL,
        "response_status" integer,
        "response_body" jsonb,
        "response_stored" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMPTZ,
        "expires_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "CHK_idempotency_durable_status"
          CHECK ("status" IN ('processing', 'completed')),
        CONSTRAINT "CHK_idempotency_durable_request_hash"
          CHECK (length("request_hash") = 64),
        CONSTRAINT "CHK_idempotency_durable_key_hash"
          CHECK (length("idempotency_key_hash") = 64),
        CONSTRAINT "CHK_idempotency_durable_scope_hash"
          CHECK (length("scope_hash") = 64)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_idempotency_durable_scope_method_path_key"
      ON "idempotency_durable_records"
        ("scope_hash", "method", "path", "idempotency_key_hash")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_idempotency_durable_expires_at"
      ON "idempotency_durable_records" ("expires_at")
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "idempotency_durable_records" TO sgs_app
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_idempotency_durable_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_idempotency_durable_scope_method_path_key"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "idempotency_durable_records"`,
    );
  }
}
