const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');
const { DataSource } = require('typeorm');

const {
  Notification,
} = require('../dist/modules/notifications/entities/notification.entity.js');
const {
  NotificationsService,
} = require('../dist/modules/notifications/notifications.service.js');
const {
  AddNotificationDurableDedupeKey1709000000406,
} = require('../dist/infra/database/migrations/1709000000406-add-notification-durable-dedupe-key.js');

const DATABASE_URL = process.env.NOTIFICATION_DEDUPE_PG17_TEST_URL;
const ISOLATED_GUARD = process.env.NOTIFICATION_DEDUPE_PG17_ISOLATED;
const TABLE = 'public.notifications';

function requireIsolatedDatabase() {
  assert(DATABASE_URL, 'NOTIFICATION_DEDUPE_PG17_TEST_URL is required');
  assert(
    ISOLATED_GUARD === '1',
    'NOTIFICATION_DEDUPE_PG17_ISOLATED=1 is required for destructive test cleanup',
  );

  const parsed = new URL(DATABASE_URL);
  assert(
    !/prod|production/i.test(`${parsed.hostname}/${parsed.pathname}`),
    'production-looking database target is not allowed',
  );
}

async function query(client, text, values) {
  return client.query(text, values);
}

async function createFixture(client) {
  await query(client, 'CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await query(client, `DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await query(
    client,
    `
    CREATE TABLE ${TABLE} (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "userId" uuid NOT NULL,
      "type" varchar NOT NULL,
      "title" varchar NOT NULL,
      "message" text NOT NULL,
      "data" jsonb NULL,
      "read" boolean NOT NULL DEFAULT false,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "readAt" timestamptz NULL,
      "deleted_at" timestamptz NULL
    )
  `,
  );
}

async function applyMigration(dataSource) {
  const migration = new AddNotificationDurableDedupeKey1709000000406();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await migration.up(runner);
    const column = await runner.query(`
      SELECT data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notifications'
        AND column_name = 'dedupe_key'
    `);
    assert.equal(column.length, 1, '0403 did not add dedupe_key');
    assert.equal(column[0].data_type, 'character varying');
    assert.equal(Number(column[0].character_maximum_length), 255);

    const index = await runner.query(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'notifications'
        AND indexname = 'UQ_notifications_company_user_dedupe_active'
    `);
    assert.equal(index.length, 1, '0403 unique index is missing');
    assert.match(index[0].indexdef, /UNIQUE INDEX/);
    assert.match(index[0].indexdef, /company_id/);
    assert.match(index[0].indexdef, /userId/);
    assert.match(index[0].indexdef, /dedupe_key/);
    assert.match(index[0].indexdef, /deleted_at IS NULL/);

    await runner.query(
      `INSERT INTO ${TABLE} ("company_id", "userId", "type", "title", "message", "dedupe_key")
       VALUES ($1, $2, 'warning', 'same', 'same', $3)`,
      [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000011',
        'migration:duplicate-check',
      ],
    );
    await assert.rejects(
      runner.query(
        `INSERT INTO ${TABLE} ("company_id", "userId", "type", "title", "message", "dedupe_key")
         VALUES ($1, $2, 'warning', 'same', 'same', $3)`,
        [
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000011',
          'migration:duplicate-check',
        ],
      ),
      (error) => error && error.code === '23505',
    );

    await runner.query(`TRUNCATE TABLE ${TABLE}`);
    await migration.down(runner);
    const afterDown = await runner.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notifications'
        AND column_name = 'dedupe_key'
    `);
    assert.equal(afterDown.length, 0, '0403 down kept dedupe_key');

    await migration.up(runner);
    const afterUp = await runner.query(`
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'notifications'
        AND indexname = 'UQ_notifications_company_user_dedupe_active'
    `);
    assert.equal(afterUp.length, 1, '0403 second up missed unique index');
  } finally {
    await runner.release();
  }
}

function notificationInput(companyId, userId, dedupeKey) {
  return {
    companyId,
    userId,
    type: 'warning',
    title: 'Apresentação não é identidade',
    message: 'Mensagem variável não participa da deduplicação.',
    data: { category: 'integration-test' },
    dedupeKey,
  };
}

async function runServiceChecks(dataSource, client) {
  const repository = dataSource.getRepository(Notification);
  const events = [];
  const service = new NotificationsService(
    repository,
    {},
    {
      sendToUser(userId, event, payload) {
        events.push({ userId, event, payload });
      },
    },
    { run: (_context, callback) => callback() },
  );

  const tenantA = '00000000-0000-4000-8000-000000000001';
  const tenantB = '00000000-0000-4000-8000-000000000002';
  const userA = '00000000-0000-4000-8000-000000000011';
  const userB = '00000000-0000-4000-8000-000000000012';
  const contentionKey = 'integration:same-event';

  const concurrentResults = await Promise.all(
    Array.from({ length: 25 }, () =>
      service.createDeduped(notificationInput(tenantA, userA, contentionKey)),
    ),
  );
  assert.equal(new Set(concurrentResults.map((row) => row.id)).size, 1);
  const contentionRows = await query(
    client,
    `SELECT count(*)::int AS count FROM ${TABLE}
     WHERE "company_id" = $1 AND "userId" = $2 AND "dedupe_key" = $3 AND "deleted_at" IS NULL`,
    [tenantA, userA, contentionKey],
  );
  assert.equal(contentionRows.rows[0].count, 1);
  assert.equal(
    events.length,
    1,
    'concurrent dedupe emitted duplicate realtime events',
  );
  const concurrentRealtimeEvents = events.length;

  const crossTenant = await Promise.all([
    service.createDeduped(
      notificationInput(tenantA, userA, 'integration:scope'),
    ),
    service.createDeduped(
      notificationInput(tenantB, userA, 'integration:scope'),
    ),
  ]);
  assert.equal(new Set(crossTenant.map((row) => row.id)).size, 2);

  const crossUser = await Promise.all([
    service.createDeduped(
      notificationInput(tenantA, userA, 'integration:user-scope'),
    ),
    service.createDeduped(
      notificationInput(tenantA, userB, 'integration:user-scope'),
    ),
  ]);
  assert.equal(new Set(crossUser.map((row) => row.id)).size, 2);

  const differentKey = await Promise.all([
    service.createDeduped(
      notificationInput(tenantA, userA, 'integration:key-a'),
    ),
    service.createDeduped(
      notificationInput(tenantA, userA, 'integration:key-b'),
    ),
  ]);
  assert.equal(new Set(differentKey.map((row) => row.id)).size, 2);

  const deleted = await service.createDeduped(
    notificationInput(tenantA, userA, 'integration:soft-delete'),
  );
  await query(
    client,
    `UPDATE ${TABLE} SET "deleted_at" = now() WHERE "id" = $1`,
    [deleted.id],
  );
  const recreated = await service.createDeduped(
    notificationInput(tenantA, userA, 'integration:soft-delete'),
  );
  assert.notEqual(recreated.id, deleted.id);

  return {
    rows: contentionRows.rows[0].count,
    realtimeEvents: concurrentRealtimeEvents,
  };
}

async function main() {
  requireIsolatedDatabase();
  const client = new Client({ connectionString: DATABASE_URL });
  let dataSource;
  try {
    await client.connect();
    const version = await query(
      client,
      `SELECT current_setting('server_version_num') AS version_num`,
    );
    assert.equal(Math.floor(Number(version.rows[0].version_num) / 10000), 17);
    await createFixture(client);

    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [
        path.resolve(
          __dirname,
          '../dist/!(database|seed|queue|worker)/**/*.entity.js',
        ),
      ],
      migrations: [],
      synchronize: false,
    });
    await dataSource.initialize();
    await applyMigration(dataSource);
    const result = await runServiceChecks(dataSource, client);

    console.log('NOTIFICATION_DEDUPE_PG17=PASS');
    console.log('MIGRATION_0403_UP_DOWN_UP=PASS');
    console.log('CONCURRENT_SAME_KEY_ROWS=1');
    console.log(`CONCURRENT_REALTIME_EVENTS=${result.realtimeEvents}`);
    console.log('CROSS_TENANT_SAME_KEY=PASS');
    console.log('CROSS_USER_SAME_KEY=PASS');
    console.log('DIFFERENT_KEY=PASS');
    console.log('SOFT_DELETE_RECREATE=PASS');
  } finally {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await query(client, `DROP TABLE IF EXISTS ${TABLE} CASCADE`).catch(
      () => undefined,
    );
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`NOTIFICATION_DEDUPE_PG17=FAIL: ${error.message}`);
  process.exitCode = 1;
});
