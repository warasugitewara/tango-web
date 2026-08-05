import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { afterEach, describe, expect, test } from 'vitest'
import { assertTestDatabaseUrl, TEST_DATABASE_URL } from '../test/database'

const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
)
const EXPECTED_INSTANT = '2026-08-01 01:02:03+00'

const EXPECTED_AUTH_INSTANT_COLUMNS = [
  'account.access_token_expires_at',
  'account.created_at',
  'account.refresh_token_expires_at',
  'account.updated_at',
  'session.created_at',
  'session.expires_at',
  'session.updated_at',
  'user.created_at',
  'user.updated_at',
  'verification.created_at',
  'verification.expires_at',
  'verification.updated_at',
] as const

const createdDatabaseNames: string[] = []

function connectionUrlFor(databaseName: string): string {
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${databaseName}`
  const value = url.toString()
  assertTestDatabaseUrl(value)
  return value
}

async function createIsolatedDatabase(): Promise<{
  databaseName: string
  connectionUrl: string
}> {
  assertTestDatabaseUrl(TEST_DATABASE_URL)
  const databaseName = `tango_migration_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`
  const admin = postgres(TEST_DATABASE_URL, { max: 1 })

  try {
    await admin`create database ${admin(databaseName)}`
  } finally {
    await admin.end()
  }

  createdDatabaseNames.push(databaseName)
  return { databaseName, connectionUrl: connectionUrlFor(databaseName) }
}

async function dropIsolatedDatabase(databaseName: string): Promise<void> {
  const admin = postgres(TEST_DATABASE_URL, { max: 1 })
  try {
    await admin`drop database ${admin(databaseName)} with (force)`
  } finally {
    await admin.end()
  }
}

async function applyMigrations(
  connectionUrl: string,
  migrationsFolder: string,
): Promise<void> {
  const client = postgres(connectionUrl, {
    max: 1,
    connection: { TimeZone: 'Asia/Tokyo' },
  })

  try {
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    await client.end()
  }
}

async function createPreTimestamptzMigrationFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'tango-old-migrations-'))
  await mkdir(join(folder, 'meta'))
  await Promise.all([
    copyFile(
      join(MIGRATIONS_FOLDER, '0000_identity.sql'),
      join(folder, '0000_identity.sql'),
    ),
    copyFile(
      join(MIGRATIONS_FOLDER, '0001_identity_merge_key_uuid.sql'),
      join(folder, '0001_identity_merge_key_uuid.sql'),
    ),
    writeFile(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify(
        {
          version: '7',
          dialect: 'postgresql',
          entries: [
            {
              idx: 0,
              version: '7',
              when: 1_785_554_551_046,
              tag: '0000_identity',
              breakpoints: true,
            },
            {
              idx: 1,
              version: '7',
              when: 1_785_643_220_710,
              tag: '0001_identity_merge_key_uuid',
              breakpoints: true,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    ),
  ])
  return folder
}

async function readAuthInstantColumnTypes(
  connectionUrl: string,
): Promise<string[]> {
  const client = postgres(connectionUrl, { max: 1 })

  try {
    const rows = await client<
      Array<{ table_name: string; column_name: string; data_type: string }>
    >`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('user', 'session', 'account', 'verification')
        and data_type like 'timestamp%'
      order by table_name, column_name
    `

    return rows.map(
      (row) => `${row.table_name}.${row.column_name}:${row.data_type}`,
    )
  } finally {
    await client.end()
  }
}

async function insertPreMigrationInstants(
  connectionUrl: string,
): Promise<void> {
  const client = postgres(connectionUrl, { max: 1 })

  try {
    await client`
      insert into "user" (
        id, name, email, email_verified, created_at, updated_at
      ) values (
        'migration-user', '移行利用者', 'migration@example.test', true,
        timestamp '2026-08-01 01:02:03', timestamp '2026-08-01 01:02:03'
      )
    `
    await client`
      insert into "session" (
        id, expires_at, token, created_at, updated_at, user_id
      ) values (
        'migration-session', timestamp '2026-08-01 01:02:03', 'migration-token',
        timestamp '2026-08-01 01:02:03', timestamp '2026-08-01 01:02:03', 'migration-user'
      )
    `
    await client`
      insert into "account" (
        id, account_id, provider_id, user_id,
        access_token_expires_at, refresh_token_expires_at,
        created_at, updated_at
      ) values (
        'migration-account', 'provider-user', 'google', 'migration-user',
        timestamp '2026-08-01 01:02:03', timestamp '2026-08-01 01:02:03',
        timestamp '2026-08-01 01:02:03', timestamp '2026-08-01 01:02:03'
      )
    `
    await client`
      insert into "verification" (
        id, identifier, value, expires_at, created_at, updated_at
      ) values (
        'migration-verification', 'migration-state', 'opaque-test-state',
        timestamp '2026-08-01 01:02:03',
        timestamp '2026-08-01 01:02:03',
        timestamp '2026-08-01 01:02:03'
      )
    `
  } finally {
    await client.end()
  }
}

async function readPreservedInstants(
  connectionUrl: string,
): Promise<Readonly<Record<string, boolean>>> {
  const client = postgres(connectionUrl, { max: 1 })

  try {
    const rows = await client<
      Array<{
        user_created_at: boolean
        user_updated_at: boolean
        session_expires_at: boolean
        session_created_at: boolean
        session_updated_at: boolean
        account_access_token_expires_at: boolean
        account_refresh_token_expires_at: boolean
        account_created_at: boolean
        account_updated_at: boolean
        verification_expires_at: boolean
        verification_created_at: boolean
        verification_updated_at: boolean
      }>
    >`
      select
        (select created_at from "user" where id = 'migration-user') = ${EXPECTED_INSTANT}::timestamptz as user_created_at,
        (select updated_at from "user" where id = 'migration-user') = ${EXPECTED_INSTANT}::timestamptz as user_updated_at,
        (select expires_at from "session" where id = 'migration-session') = ${EXPECTED_INSTANT}::timestamptz as session_expires_at,
        (select created_at from "session" where id = 'migration-session') = ${EXPECTED_INSTANT}::timestamptz as session_created_at,
        (select updated_at from "session" where id = 'migration-session') = ${EXPECTED_INSTANT}::timestamptz as session_updated_at,
        (select access_token_expires_at from "account" where id = 'migration-account') = ${EXPECTED_INSTANT}::timestamptz as account_access_token_expires_at,
        (select refresh_token_expires_at from "account" where id = 'migration-account') = ${EXPECTED_INSTANT}::timestamptz as account_refresh_token_expires_at,
        (select created_at from "account" where id = 'migration-account') = ${EXPECTED_INSTANT}::timestamptz as account_created_at,
        (select updated_at from "account" where id = 'migration-account') = ${EXPECTED_INSTANT}::timestamptz as account_updated_at,
        (select expires_at from "verification" where id = 'migration-verification') = ${EXPECTED_INSTANT}::timestamptz as verification_expires_at,
        (select created_at from "verification" where id = 'migration-verification') = ${EXPECTED_INSTANT}::timestamptz as verification_created_at,
        (select updated_at from "verification" where id = 'migration-verification') = ${EXPECTED_INSTANT}::timestamptz as verification_updated_at
    `

    return rows[0] ?? {}
  } finally {
    await client.end()
  }
}

afterEach(async () => {
  const names = createdDatabaseNames.splice(0)
  for (const databaseName of names) {
    await dropIsolatedDatabase(databaseName)
  }
})

describe('Better Auth instant migrations', () => {
  test('creates every auth instant as TIMESTAMPTZ on an empty database', async () => {
    const isolated = await createIsolatedDatabase()

    await applyMigrations(isolated.connectionUrl, MIGRATIONS_FOLDER)

    const types = await readAuthInstantColumnTypes(isolated.connectionUrl)
    expect(types).toEqual(
      [...EXPECTED_AUTH_INSTANT_COLUMNS]
        .sort()
        .map((column) => `${column}:timestamp with time zone`),
    )
  })

  test('preserves existing UTC instants when migrating the previous schema', async () => {
    const isolated = await createIsolatedDatabase()
    const previousMigrations = await createPreTimestamptzMigrationFolder()

    try {
      await applyMigrations(isolated.connectionUrl, previousMigrations)
      await insertPreMigrationInstants(isolated.connectionUrl)

      await applyMigrations(isolated.connectionUrl, MIGRATIONS_FOLDER)

      expect(await readPreservedInstants(isolated.connectionUrl)).toEqual({
        user_created_at: true,
        user_updated_at: true,
        session_expires_at: true,
        session_created_at: true,
        session_updated_at: true,
        account_access_token_expires_at: true,
        account_refresh_token_expires_at: true,
        account_created_at: true,
        account_updated_at: true,
        verification_expires_at: true,
        verification_created_at: true,
        verification_updated_at: true,
      })
    } finally {
      await rm(previousMigrations, { recursive: true, force: true })
    }
  })
})
