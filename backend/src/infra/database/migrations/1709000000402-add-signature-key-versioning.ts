import { MigrationInterface, QueryRunner } from 'typeorm';

type RoleIdentityRow = {
  current_user: string;
  session_user: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
};

type RoleMembershipRow = {
  grantor: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
};

type FunctionContractRow = {
  owner: string;
  security_definer: boolean;
  config: string[] | null;
  public_execute: boolean;
  admin_execute: boolean;
  app_execute: boolean;
  owner_can_select_signatures: boolean;
};

const FUNCTION_OWNER = 'sgs_function_owner' as const;
const FUNCTION_SIGNATURE =
  'public.verify_signature_by_hash_public_versioned(text)' as const;

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

function optionLiteral(value: boolean): 'TRUE' | 'FALSE' {
  return value ? 'TRUE' : 'FALSE';
}

async function queryRows<T>(
  queryRunner: QueryRunner,
  sql: string,
): Promise<T[]> {
  return rowsOf<T>(await queryRunner.query(sql));
}

async function assertMigrationExecutor(
  queryRunner: QueryRunner,
): Promise<{ currentUser: string; isSuperuser: boolean }> {
  const identity = (
    await queryRows<RoleIdentityRow>(
      queryRunner,
      `
        SELECT
          current_user,
          session_user,
          r.rolsuper,
          r.rolcreaterole
        FROM pg_roles AS r
        WHERE r.rolname = current_user
      `,
    )
  )[0];

  if (!identity?.current_user || !identity.session_user) {
    throw new Error('0402 could not identify the migration executor');
  }
  if (
    identity.current_user === 'sgs_app' ||
    identity.session_user === 'sgs_app'
  ) {
    throw new Error('0402 cannot run with the runtime role sgs_app');
  }

  const isSuperuser = booleanValue(identity.rolsuper);
  if (!isSuperuser && !booleanValue(identity.rolcreaterole)) {
    throw new Error('0402 requires a SUPERUSER or CREATEROLE executor');
  }

  return { currentUser: identity.current_user, isSuperuser };
}

async function assertPrerequisites(queryRunner: QueryRunner): Promise<void> {
  const roles = await queryRows<{ role_name: string; present: boolean }>(
    queryRunner,
    `
      SELECT required.role_name, EXISTS (
        SELECT 1 FROM pg_roles WHERE pg_roles.rolname = required.role_name
      ) AS present
      FROM unnest(ARRAY['sgs_function_owner', 'sgs_app', 'sgs_admin'])
        AS required(role_name)
    `,
  );
  const missingRole = roles.find(({ present }) => !booleanValue(present));
  if (missingRole) {
    throw new Error(`0402 required role is absent: ${missingRole.role_name}`);
  }

  const table = (
    await queryRows<{ present: boolean }>(
      queryRunner,
      `SELECT to_regclass('public.signatures') IS NOT NULL AS present`,
    )
  )[0];
  if (!booleanValue(table?.present)) {
    throw new Error('0402 required table public.signatures is absent');
  }

  const ownerState = (
    await queryRows<{
      can_create: boolean;
      can_select_signatures: boolean;
    }>(
      queryRunner,
      `
        SELECT
          has_schema_privilege('${FUNCTION_OWNER}', 'public', 'CREATE')
            AS can_create,
          has_table_privilege('${FUNCTION_OWNER}', 'public.signatures', 'SELECT')
            AS can_select_signatures
      `,
    )
  )[0];
  if (booleanValue(ownerState?.can_create)) {
    throw new Error(
      '0402 found pre-existing CREATE privilege for sgs_function_owner',
    );
  }
  if (!booleanValue(ownerState?.can_select_signatures)) {
    throw new Error(
      '0402 requires sgs_function_owner SELECT on public.signatures',
    );
  }
}

async function readExecutorMemberships(
  queryRunner: QueryRunner,
): Promise<RoleMembershipRow[]> {
  return queryRows<RoleMembershipRow>(
    queryRunner,
    `
      SELECT
        grantor.rolname AS grantor,
        am.admin_option,
        am.inherit_option,
        am.set_option
      FROM pg_auth_members AS am
      JOIN pg_roles AS granted_role ON granted_role.oid = am.roleid
      JOIN pg_roles AS member_role ON member_role.oid = am.member
      JOIN pg_roles AS grantor ON grantor.oid = am.grantor
      WHERE granted_role.rolname = '${FUNCTION_OWNER}'
        AND member_role.rolname = current_user
    `,
  );
}

function captureExecutorControlledMembership(
  memberships: RoleMembershipRow[],
  currentUser: string,
): RoleMembershipRow | undefined {
  const membershipsByExecutor = memberships.filter(
    (membership) => membership.grantor === currentUser,
  );

  if (membershipsByExecutor.length > 1) {
    throw new Error(
      '0402 found multiple executor grants for sgs_function_owner',
    );
  }
  if (memberships.some((membership) => booleanValue(membership.set_option))) {
    throw new Error(
      '0402 found a pre-existing SET-capable membership for sgs_function_owner',
    );
  }
  if (
    memberships.some((membership) => booleanValue(membership.inherit_option))
  ) {
    throw new Error(
      '0402 found a pre-existing INHERIT membership for sgs_function_owner',
    );
  }

  // PostgreSQL 17 can keep an automatic membership whose grantor is another
  // role (for example the bootstrap/provider role). That row is valid state
  // and must remain untouched. Only the executor-controlled grant is mutated
  // and later restored, mirroring the proven 0392 ownership-transfer pattern.
  return membershipsByExecutor[0];
}

async function establishTemporaryMembership(
  queryRunner: QueryRunner,
  currentUser: string,
): Promise<void> {
  // Deliberately omit GRANTED BY. PostgreSQL 17 chooses the grantor the
  // executor can legally use; forcing one can itself fail under CREATEROLE.
  await queryRunner.query(`
    GRANT ${FUNCTION_OWNER} TO CURRENT_USER
      WITH SET TRUE, INHERIT FALSE
  `);

  const memberships = await readExecutorMemberships(queryRunner);
  if (
    !memberships.some(
      (membership) =>
        membership.grantor === currentUser &&
        booleanValue(membership.set_option) &&
        !booleanValue(membership.inherit_option),
    )
  ) {
    throw new Error('0402 could not establish temporary SET capability');
  }
}

async function restoreExecutorMembership(
  queryRunner: QueryRunner,
  previousMembership: RoleMembershipRow | undefined,
): Promise<void> {
  if (!previousMembership) {
    await queryRunner.query(`
      REVOKE ${FUNCTION_OWNER}
        FROM CURRENT_USER
    `);
    return;
  }

  await queryRunner.query(`
    GRANT ${FUNCTION_OWNER} TO CURRENT_USER
      WITH ADMIN ${optionLiteral(booleanValue(previousMembership.admin_option))},
           INHERIT ${optionLiteral(booleanValue(previousMembership.inherit_option))},
           SET ${optionLiteral(booleanValue(previousMembership.set_option))}
  `);
}

async function assertFunctionContract(queryRunner: QueryRunner): Promise<void> {
  const contract = (
    await queryRows<FunctionContractRow>(
      queryRunner,
      `
        SELECT
          pg_get_userbyid(p.proowner) AS owner,
          p.prosecdef AS security_definer,
          p.proconfig AS config,
          EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
            WHERE acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
          ) AS public_execute,
          has_function_privilege(
            'sgs_admin', '${FUNCTION_SIGNATURE}', 'EXECUTE'
          ) AS admin_execute,
          has_function_privilege(
            'sgs_app', '${FUNCTION_SIGNATURE}', 'EXECUTE'
          ) AS app_execute,
          has_table_privilege(
            '${FUNCTION_OWNER}', 'public.signatures', 'SELECT'
          ) AS owner_can_select_signatures
        FROM pg_proc AS p
        WHERE p.oid = '${FUNCTION_SIGNATURE}'::regprocedure
      `,
    )
  )[0];

  if (
    !contract ||
    contract.owner !== FUNCTION_OWNER ||
    !booleanValue(contract.security_definer) ||
    !contract.config?.includes('search_path=pg_catalog, public, pg_temp') ||
    booleanValue(contract.public_execute) ||
    booleanValue(contract.admin_execute) ||
    !booleanValue(contract.app_execute) ||
    !booleanValue(contract.owner_can_select_signatures)
  ) {
    throw new Error('0402 versioned verification function contract failed');
  }
}

/**
 * Adds non-secret key/version metadata without rewriting historical tokens.
 *
 * PostgreSQL 17 requires the migration executor to be able to SET ROLE to the
 * target function owner during ownership transfer. The capability and schema
 * CREATE privilege are temporary, fail-closed, and restored before commit.
 */
export class AddSignatureKeyVersioning1709000000402 implements MigrationInterface {
  name = 'AddSignatureKeyVersioning1709000000402';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const executor = await assertMigrationExecutor(queryRunner);
    await assertPrerequisites(queryRunner);

    const previousExecutorMembership = captureExecutorControlledMembership(
      await readExecutorMemberships(queryRunner),
      executor.currentUser,
    );

    let temporaryMembership = false;
    let temporarySchemaCreate = false;

    try {
      if (!executor.isSuperuser) {
        temporaryMembership = true;
        await establishTemporaryMembership(queryRunner, executor.currentUser);
      }

      await queryRunner.query(`
        GRANT CREATE ON SCHEMA public
          TO ${FUNCTION_OWNER}
      `);
      temporarySchemaCreate = true;

      const schemaAfterGrant = (
        await queryRows<{ has_create: boolean }>(
          queryRunner,
          `
            SELECT has_schema_privilege(
              '${FUNCTION_OWNER}', 'public', 'CREATE'
            ) AS has_create
          `,
        )
      )[0];
      if (!booleanValue(schemaAfterGrant?.has_create)) {
        throw new Error('0402 could not establish temporary schema CREATE');
      }

      await queryRunner.query(`
        ALTER TABLE public."signatures"
          ADD COLUMN IF NOT EXISTS "signature_key_id" character varying(64),
          ADD COLUMN IF NOT EXISTS "timestamp_token_version" character varying(64)
      `);

      await queryRunner.query(`
        CREATE OR REPLACE FUNCTION public.verify_signature_by_hash_public_versioned(
          p_hash text
        )
        RETURNS TABLE (
          signature_hash text,
          signed_at timestamptz,
          timestamp_authority text,
          type text,
          timestamp_token text,
          integrity_payload jsonb,
          signature_key_id text,
          timestamp_token_version text
        )
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $$
        BEGIN
          IF NOT (p_hash ~ '^[a-f0-9]{64}$') THEN
            RETURN;
          END IF;

          RETURN QUERY
          SELECT
            s.signature_hash::text,
            s.signed_at AT TIME ZONE 'UTC',
            s.timestamp_authority::text,
            s.type::text,
            s.timestamp_token::text,
            s.integrity_payload,
            s.signature_key_id::text,
            s.timestamp_token_version::text
          FROM public.signatures AS s
          WHERE s.signature_hash = p_hash
            AND s.deleted_at IS NULL
          LIMIT 1;
        END;
        $$
      `);

      // Revoke the default PUBLIC grant while the migration executor still
      // owns the freshly created function, before transferring ownership.
      await queryRunner.query(`
        REVOKE EXECUTE ON FUNCTION
          ${FUNCTION_SIGNATURE}
        FROM PUBLIC, sgs_admin
      `);
      await queryRunner.query(`
        GRANT EXECUTE ON FUNCTION
          ${FUNCTION_SIGNATURE}
        TO sgs_app
      `);
      await queryRunner.query(`
        ALTER FUNCTION ${FUNCTION_SIGNATURE}
          OWNER TO ${FUNCTION_OWNER}
      `);

      await queryRunner.query(`
        REVOKE CREATE ON SCHEMA public
          FROM ${FUNCTION_OWNER}
      `);
      temporarySchemaCreate = false;

      if (temporaryMembership) {
        await restoreExecutorMembership(
          queryRunner,
          previousExecutorMembership,
        );
        temporaryMembership = false;
      }

      await assertFunctionContract(queryRunner);
    } catch (error) {
      const cleanupErrors: Error[] = [];

      if (temporarySchemaCreate) {
        try {
          await queryRunner.query(`
            REVOKE CREATE ON SCHEMA public
              FROM ${FUNCTION_OWNER}
          `);
        } catch (cleanupError) {
          cleanupErrors.push(
            cleanupError instanceof Error
              ? cleanupError
              : new Error(String(cleanupError)),
          );
        }
      }

      if (temporaryMembership) {
        try {
          await restoreExecutorMembership(
            queryRunner,
            previousExecutorMembership,
          );
        } catch (cleanupError) {
          cleanupErrors.push(
            cleanupError instanceof Error
              ? cleanupError
              : new Error(String(cleanupError)),
          );
        }
      }

      if (cleanupErrors.length > 0) {
        throw new Error(
          `0402 operation failed and cleanup also failed: ${cleanupErrors
            .map((cleanupError) => cleanupError.message)
            .join(' | ')}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const executor = await assertMigrationExecutor(queryRunner);
    const previousExecutorMembership = captureExecutorControlledMembership(
      await readExecutorMemberships(queryRunner),
      executor.currentUser,
    );

    let temporaryMembership = false;
    let roleWasSet = false;

    try {
      const functionRows = await queryRows<{ owner: string | null }>(
        queryRunner,
        `
          SELECT pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc AS p
          WHERE p.oid = to_regprocedure('${FUNCTION_SIGNATURE}')
        `,
      );

      if (functionRows[0]) {
        if (functionRows[0].owner !== FUNCTION_OWNER) {
          throw new Error(
            `0402 down refuses function owned by ${functionRows[0].owner}`,
          );
        }

        if (!executor.isSuperuser) {
          temporaryMembership = true;
          await establishTemporaryMembership(queryRunner, executor.currentUser);
        }

        await queryRunner.query(`SET ROLE ${FUNCTION_OWNER}`);
        roleWasSet = true;
        await queryRunner.query(`DROP FUNCTION ${FUNCTION_SIGNATURE}`);
        await queryRunner.query('RESET ROLE');
        roleWasSet = false;

        if (temporaryMembership) {
          await restoreExecutorMembership(
            queryRunner,
            previousExecutorMembership,
          );
          temporaryMembership = false;
        }
      }

      await queryRunner.query(`
        ALTER TABLE public."signatures"
          DROP COLUMN IF EXISTS "timestamp_token_version",
          DROP COLUMN IF EXISTS "signature_key_id"
      `);
    } catch (error) {
      if (roleWasSet) {
        try {
          await queryRunner.query('RESET ROLE');
        } catch {
          // Transaction rollback remains the final safety boundary.
        }
      }
      if (temporaryMembership) {
        try {
          await restoreExecutorMembership(
            queryRunner,
            previousExecutorMembership,
          );
        } catch {
          // Preserve the original rollback error.
        }
      }
      throw error;
    }
  }
}
