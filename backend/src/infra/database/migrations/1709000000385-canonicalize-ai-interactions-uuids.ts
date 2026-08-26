import { MigrationInterface, QueryRunner } from 'typeorm';

export class CanonicalizeAiInteractionsUuids1709000000385 implements MigrationInterface {
  name = 'CanonicalizeAiInteractionsUuids1709000000385';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.try_parse_uuid(value text)
      RETURNS uuid
      LANGUAGE plpgsql
      IMMUTABLE
      AS $$
      BEGIN
        IF value IS NULL OR btrim(value) = '' THEN
          RETURN NULL;
        END IF;

        RETURN value::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
      END;
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "ai_interactions"
        ADD COLUMN IF NOT EXISTS "tenant_uuid" uuid,
        ADD COLUMN IF NOT EXISTS "user_uuid" uuid,
        ADD COLUMN IF NOT EXISTS "user_ref_status" varchar(32) NOT NULL DEFAULT 'unclassified'
    `);

    await queryRunner.query(`
      UPDATE "ai_interactions" ai
      SET
        "tenant_uuid" = public.try_parse_uuid(ai."tenant_id"::text),
        "user_uuid" = CASE
          WHEN u."id" IS NOT NULL THEN u."id"
          ELSE NULL
        END,
        "user_ref_status" = CASE
          WHEN public.try_parse_uuid(ai."user_id"::text) IS NULL THEN 'invalid_uuid'
          WHEN u."id" IS NULL THEN 'missing_user'
          ELSE 'valid_user'
        END
      FROM (
        SELECT
          ai_inner."id",
          ai_inner."created_at",
          public.try_parse_uuid(ai_inner."user_id"::text) AS parsed_user_uuid
        FROM "ai_interactions" ai_inner
      ) parsed
      LEFT JOIN "users" u ON u."id" = parsed.parsed_user_uuid
      WHERE ai."id" = parsed."id"
        AND ai."created_at" = parsed."created_at"
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.sync_ai_interactions_uuid_refs()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        parsed_tenant uuid;
        parsed_user uuid;
        existing_user uuid;
      BEGIN
        parsed_tenant := public.try_parse_uuid(NEW.tenant_id::text);
        parsed_user := public.try_parse_uuid(NEW.user_id::text);

        NEW.tenant_uuid := parsed_tenant;

        IF parsed_user IS NULL THEN
          NEW.user_uuid := NULL;
          NEW.user_ref_status := 'invalid_uuid';
        ELSE
          SELECT u.id INTO existing_user
          FROM public.users u
          WHERE u.id = parsed_user
          LIMIT 1;

          IF existing_user IS NULL THEN
            NEW.user_uuid := NULL;
            NEW.user_ref_status := 'missing_user';
          ELSE
            NEW.user_uuid := existing_user;
            NEW.user_ref_status := 'valid_user';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_ai_interactions_uuid_refs" ON "ai_interactions";
      CREATE TRIGGER "trg_ai_interactions_uuid_refs"
      BEFORE INSERT OR UPDATE OF "tenant_id", "user_id"
      ON "ai_interactions"
      FOR EACH ROW
      EXECUTE FUNCTION public.sync_ai_interactions_uuid_refs();
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'FK_ai_interactions_tenant_uuid_companies'
            AND conrelid = 'public.ai_interactions'::regclass
        ) THEN
          ALTER TABLE "ai_interactions"
          ADD CONSTRAINT "FK_ai_interactions_tenant_uuid_companies"
          FOREIGN KEY ("tenant_uuid")
          REFERENCES "companies"("id");
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'FK_ai_interactions_user_uuid_users'
            AND conrelid = 'public.ai_interactions'::regclass
        ) THEN
          ALTER TABLE "ai_interactions"
          ADD CONSTRAINT "FK_ai_interactions_user_uuid_users"
          FOREIGN KEY ("user_uuid")
          REFERENCES "users"("id");
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ai_interactions_tenant_uuid_created"
      ON "ai_interactions" ("tenant_uuid", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ai_interactions_user_ref_status"
      ON "ai_interactions" ("user_ref_status")
      WHERE "user_ref_status" <> 'valid_user'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_ai_interactions_user_ref_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_ai_interactions_tenant_uuid_created"`,
    );
    await queryRunner.query(`
      ALTER TABLE "ai_interactions"
        DROP CONSTRAINT IF EXISTS "FK_ai_interactions_user_uuid_users",
        DROP CONSTRAINT IF EXISTS "FK_ai_interactions_tenant_uuid_companies"
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_ai_interactions_uuid_refs" ON "ai_interactions"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS public.sync_ai_interactions_uuid_refs()`,
    );
    await queryRunner.query(`
      ALTER TABLE "ai_interactions"
        DROP COLUMN IF EXISTS "user_ref_status",
        DROP COLUMN IF EXISTS "user_uuid",
        DROP COLUMN IF EXISTS "tenant_uuid"
    `);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS public.try_parse_uuid(text)`,
    );
  }
}
