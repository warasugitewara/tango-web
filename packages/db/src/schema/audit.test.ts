import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  createTestDatabase,
  resetIdentityTables,
  type TestDatabaseHandle,
} from '../test/database'
import { type AuditMetadata, assertAuditMetadata, auditLogs } from './audit'

const PROHIBITED_METADATA_CASES = [
  ['top-level learning key', { front: true }],
  ['nested learning key', { payload: { front: true } }],
  ['learning key inside an array', { changes: [{ front: true }] }],
  ['mixed-case learning key', { Front: true }],
  ['upper-case nested learning key', { payload: { CONTENT: true } }],
  ['generic token key', { token: true }],
  ['snake_case access token key', { auth: { access_token: true } }],
  ['kebab-case refresh token key', { auth: { 'refresh-token': true } }],
  ['upper-case password key', { PASSWORD: true }],
  ['kebab-case client secret key', { auth: { 'client-secret': true } }],
  ['cookie key', { cookie: true }],
  ['session key', { session: true }],
  ['camelCase OAuth credential key', { oauthCredential: true }],
] satisfies ReadonlyArray<readonly [string, AuditMetadata]>

describe('audit metadata redaction', () => {
  let handle: TestDatabaseHandle | undefined

  function database(): TestDatabaseHandle {
    if (handle === undefined) {
      throw new Error('テストDBが初期化されていません。')
    }
    return handle
  }

  beforeAll(async () => {
    handle = await createTestDatabase()
  })

  afterAll(async () => {
    await handle?.close()
  })

  beforeEach(async () => {
    await resetIdentityTables(database())
  })

  test.each(PROHIBITED_METADATA_CASES)(
    'runtime validation rejects a prohibited key at %s',
    (_caseName, metadata) => {
      expect(() => assertAuditMetadata(metadata)).toThrow()
    },
  )

  test('runtime validation accepts metadata made only from operational fields', () => {
    expect(() =>
      assertAuditMetadata({
        outcome: 'created',
        counts: { created: 2 },
        sources: [{ kind: 'csv' }],
      }),
    ).not.toThrow()
  })

  test('Drizzle writes also apply the runtime validation', async () => {
    await expect(
      database()
        .db.insert(auditLogs)
        .values({
          id: randomUUID(),
          requestId: 'request-runtime-redaction',
          eventType: 'test.runtime-redaction',
          metadata: { payload: { front: true } },
        }),
    ).rejects.toThrow(/front/)
  })

  test.each(PROHIBITED_METADATA_CASES)(
    'database constraint rejects a prohibited key at %s',
    async (_caseName, metadata) => {
      const insert = database().db.execute(sql`
        insert into audit_logs (id, request_id, event_type, metadata)
        values (
          ${randomUUID()},
          'request-database-redaction',
          'test.database-redaction',
          ${JSON.stringify(metadata)}::jsonb
        )
      `)

      await expect(insert).rejects.toThrow()
    },
  )

  test('database constraint accepts safe metadata', async () => {
    const metadata: AuditMetadata = {
      outcome: 'created',
      counts: { created: 2 },
      sources: [{ kind: 'csv' }],
    }

    await database().db.execute(sql`
      insert into audit_logs (id, request_id, event_type, metadata)
      values (
        ${randomUUID()},
        'request-safe-metadata',
        'test.safe-metadata',
        ${JSON.stringify(metadata)}::jsonb
      )
    `)

    const rows = await database().db.execute<{ metadata: AuditMetadata }>(sql`
      select metadata
      from audit_logs
      where request_id = 'request-safe-metadata'
    `)
    expect(rows[0]?.metadata).toEqual(metadata)
  })
})
