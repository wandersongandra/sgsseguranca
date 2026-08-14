const { Client } = require('/app/node_modules/pg');

const connectionString = process.env.DATABASE_MIGRATION_URL;
if (!connectionString || !connectionString.includes('/sgs_loadtest')) {
  throw new Error('load-test grant guard rejected the database URL');
}

const client = new Client({ connectionString });

async function main() {
  await client.connect();
  await client.query('GRANT USAGE ON SCHEMA public TO sgs_app');
  await client.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO sgs_app',
  );
  await client.query(
    'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO sgs_app',
  );
  await client.query(
    'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO sgs_app',
  );
  await client.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE sgs_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO sgs_app',
  );
  await client.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE sgs_migrator IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO sgs_app',
  );
  await client.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE sgs_migrator IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO sgs_app',
  );
  console.log('[loadtest-grants] runtime privileges applied without printing credentials');
}

main()
  .catch((error) => {
    console.error('[loadtest-grants] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
