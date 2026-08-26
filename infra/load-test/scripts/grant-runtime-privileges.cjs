const { Client } = require("/app/node_modules/pg");

const connectionString = process.env.DATABASE_MIGRATION_URL;
if (!connectionString || !connectionString.includes("/sgs_loadtest")) {
  throw new Error("load-test grant guard rejected the database URL");
}

const client = new Client({ connectionString });

async function main() {
  await client.connect();
  await client.query("GRANT USAGE ON SCHEMA public TO sgs_app");
  await client.query(
    "GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO sgs_app",
  );
  await client.query(
    "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO sgs_app",
  );
  await client.query(
    "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM sgs_app",
  );
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('public.company_dashboard_metrics') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES ON TABLE public.company_dashboard_metrics FROM PUBLIC, sgs_app;
      END IF;
      IF to_regclass('public.apr_risk_rankings') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES ON TABLE public.apr_risk_rankings FROM PUBLIC, sgs_app;
      END IF;
    END $$;
  `);
  await client.query(
    "ALTER DEFAULT PRIVILEGES FOR ROLE sgs_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO sgs_app",
  );
  await client.query(
    "ALTER DEFAULT PRIVILEGES FOR ROLE sgs_migrator IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO sgs_app",
  );
  await client.query(`
    GRANT EXECUTE ON FUNCTION
      public.current_company(),
      public.is_super_admin(),
      public.current_user_role(),
      public.current_app_user_id(),
      public.current_site_id(),
      public.current_site_scope(),
      public.current_site_ids(),
      public.update_updated_at_column(),
      public.try_parse_uuid(text),
      public.find_login_user(text, text),
      public.update_login_user_password_hash(uuid, text),
      public.find_user_bridge(uuid, uuid),
      public.reset_login_user_password(uuid, text),
      public.verify_signature_by_hash_public(text),
      public.verify_apr_evidence_by_hash_public(text)
    TO sgs_app
  `);
  console.log(
    "[loadtest-grants] runtime privileges applied without printing credentials",
  );
}

main()
  .catch((error) => {
    console.error("[loadtest-grants] failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
