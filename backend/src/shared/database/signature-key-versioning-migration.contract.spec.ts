import type { QueryRunner } from 'typeorm';
import { AddSignatureKeyVersioning1709000000402 } from '../../infra/database/migrations/1709000000402-add-signature-key-versioning';

type QueryRunnerDouble = Pick<QueryRunner, 'query'> & {
  query: jest.MockedFunction<QueryRunner['query']>;
};

type RunnerOptions = {
  preExistingSetMembership?: boolean;
  providerGrantedMembership?: boolean;
  functionExists?: boolean;
};

const makeQueryRunner = (options: RunnerOptions = {}): QueryRunnerDouble => {
  let temporarySetMembership = false;

  const resolveQuery = (rawSql: string): unknown => {
    const sql = String(rawSql).replace(/\s+/g, ' ').trim().toLowerCase();

    if (
      sql.includes('from pg_roles as r') &&
      sql.includes('where r.rolname = current_user')
    ) {
      return [
        {
          current_user: 'migration_executor',
          session_user: 'migration_executor',
          rolsuper: false,
          rolcreaterole: true,
        },
      ];
    }

    if (
      sql.includes(
        "unnest(array['sgs_function_owner', 'sgs_app', 'sgs_admin'])",
      )
    ) {
      return [
        { role_name: 'sgs_function_owner', present: true },
        { role_name: 'sgs_app', present: true },
        { role_name: 'sgs_admin', present: true },
      ];
    }

    if (sql.includes("to_regclass('public.signatures')")) {
      return [{ present: true }];
    }

    if (
      sql.includes(
        "has_schema_privilege('sgs_function_owner', 'public', 'create')",
      ) &&
      sql.includes(
        "has_table_privilege('sgs_function_owner', 'public.signatures', 'select')",
      )
    ) {
      return [{ can_create: false, can_select_signatures: true }];
    }

    if (
      sql.includes(
        "has_schema_privilege( 'sgs_function_owner', 'public', 'create' ) as has_create",
      )
    ) {
      return [{ has_create: true }];
    }

    if (sql.startsWith('grant sgs_function_owner to current_user')) {
      temporarySetMembership = sql.includes('set true');
      if (sql.includes('set false')) temporarySetMembership = false;
      return [];
    }

    if (sql.startsWith('revoke sgs_function_owner')) {
      temporarySetMembership = false;
      return [];
    }

    if (
      sql.includes('from pg_auth_members as am') &&
      sql.includes("granted_role.rolname = 'sgs_function_owner'")
    ) {
      const rows = [
        {
          grantor: 'migration_executor',
          admin_option: true,
          inherit_option: false,
          set_option:
            options.preExistingSetMembership || temporarySetMembership,
        },
      ];
      if (options.providerGrantedMembership) {
        rows.unshift({
          grantor: 'postgres',
          admin_option: true,
          inherit_option: false,
          set_option: false,
        });
      }
      return rows;
    }

    if (
      sql.includes(
        "where p.oid = 'public.verify_signature_by_hash_public_versioned(text)'::regprocedure",
      )
    ) {
      return [
        {
          owner: 'sgs_function_owner',
          security_definer: true,
          config: ['search_path=pg_catalog, public, pg_temp'],
          public_execute: false,
          admin_execute: false,
          app_execute: true,
          owner_can_select_signatures: true,
        },
      ];
    }

    if (
      sql.includes(
        "to_regprocedure('public.verify_signature_by_hash_public_versioned(text)')",
      )
    ) {
      return options.functionExists === false
        ? []
        : [{ owner: 'sgs_function_owner' }];
    }

    return [];
  };

  const query = jest.fn((rawSql: string) =>
    Promise.resolve(resolveQuery(rawSql)),
  ) as unknown as jest.MockedFunction<QueryRunner['query']>;

  return { query };
};

const flattenSql = (queryRunner: QueryRunnerDouble): string =>
  queryRunner.query.mock.calls
    .map(([sql]) => String(sql))
    .join('\n')
    .replace(/\s+/g, ' ')
    .toLowerCase();

describe('signature key versioning migration contract', () => {
  it('é aditiva e não reescreve tokens históricos nem o ledger', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new AddSignatureKeyVersioning1709000000402();

    await migration.up(queryRunner as unknown as QueryRunner);

    const sql = flattenSql(queryRunner);
    expect(sql).toContain(
      'alter table public."signatures" add column if not exists "signature_key_id"',
    );
    expect(sql).toContain('"timestamp_token_version"');
    expect(sql).toContain('verify_signature_by_hash_public_versioned');
    expect(sql).not.toMatch(/update\s+public\.?("?signatures"?)/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.?("?signatures"?)/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.?("?migrations"?)/i);
    expect(sql).not.toMatch(/update\s+public\.?("?migrations"?)/i);
  });

  it('usa capability temporária de SET ROLE e CREATE para ownership no PostgreSQL 17', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new AddSignatureKeyVersioning1709000000402();

    await migration.up(queryRunner as unknown as QueryRunner);

    const sql = flattenSql(queryRunner);
    expect(sql).toContain(
      'grant sgs_function_owner to current_user with set true, inherit false',
    );
    expect(sql).toContain(
      'grant create on schema public to sgs_function_owner',
    );
    expect(sql).toContain(
      'alter function public.verify_signature_by_hash_public_versioned(text) owner to sgs_function_owner',
    );
    expect(sql).toContain(
      'revoke create on schema public from sgs_function_owner',
    );
    expect(sql).toContain('set false');
  });

  it('preserva membership automática concedida por provider/role diferente', async () => {
    const queryRunner = makeQueryRunner({ providerGrantedMembership: true });
    const migration = new AddSignatureKeyVersioning1709000000402();

    await expect(
      migration.up(queryRunner as unknown as QueryRunner),
    ).resolves.toBeUndefined();
  });

  it('mantém o contrato antigo e restringe a função versionada ao runtime', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new AddSignatureKeyVersioning1709000000402();

    await migration.up(queryRunner as unknown as QueryRunner);

    const sql = flattenSql(queryRunner);
    expect(sql).not.toContain(
      'drop function public.verify_signature_by_hash_public(text)',
    );
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = pg_catalog, public, pg_temp');
    expect(sql).toContain('revoke execute on function');
    expect(sql).toContain('from public, sgs_admin');
    expect(sql).toContain('grant execute on function');
    expect(sql).toContain('to sgs_app');
  });

  it('falha fechado se o executor já possui SET inesperado no owner role', async () => {
    const queryRunner = makeQueryRunner({ preExistingSetMembership: true });
    const migration = new AddSignatureKeyVersioning1709000000402();

    await expect(
      migration.up(queryRunner as unknown as QueryRunner),
    ).rejects.toThrow('pre-existing SET-capable membership');
  });

  it('faz rollback owner-aware somente dos artefatos novos', async () => {
    const queryRunner = makeQueryRunner();
    const migration = new AddSignatureKeyVersioning1709000000402();

    await migration.down(queryRunner as unknown as QueryRunner);

    const sql = flattenSql(queryRunner);
    expect(sql).toContain('set role sgs_function_owner');
    expect(sql).toContain(
      'drop function public.verify_signature_by_hash_public_versioned(text)',
    );
    expect(sql).toContain('drop column if exists "timestamp_token_version"');
    expect(sql).toContain('drop column if exists "signature_key_id"');
    expect(sql).not.toContain(
      'drop function public.verify_signature_by_hash_public(text)',
    );
    expect(sql).not.toContain('drop table');
  });
});
