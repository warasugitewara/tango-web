import { schema } from '@tango/db'
import {
  createTestDatabase,
  resetIdentityTables,
  type TestDatabaseHandle,
} from '@tango/db/test'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

let databaseHandle: TestDatabaseHandle | null = null

function requireDatabase(): TestDatabaseHandle {
  if (databaseHandle === null) {
    throw new Error('テストDBが初期化されていません。')
  }
  return databaseHandle
}

beforeAll(async () => {
  databaseHandle = await createTestDatabase()
})

afterAll(async () => {
  if (databaseHandle !== null) {
    await databaseHandle.close()
  }
})

beforeEach(async () => {
  await resetIdentityTables(requireDatabase())
})

describe('provider account identity constraint', () => {
  test('allows identities when either provider or account coordinate differs', async () => {
    const db = requireDatabase().db
    const now = new Date('2026-08-01T01:00:00.000Z')
    await db.insert(schema.user).values({
      id: 'provider-coordinate-owner',
      name: '座標所有者',
      email: 'provider-coordinate-owner@example.test',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })

    await db.insert(schema.account).values([
      {
        id: 'provider-a-shared-account',
        accountId: 'shared-account-coordinate',
        providerId: 'dummy-provider-a',
        userId: 'provider-coordinate-owner',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'provider-b-shared-account',
        accountId: 'shared-account-coordinate',
        providerId: 'dummy-provider-b',
        userId: 'provider-coordinate-owner',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'provider-a-other-account',
        accountId: 'other-account-coordinate',
        providerId: 'dummy-provider-a',
        userId: 'provider-coordinate-owner',
        createdAt: now,
        updatedAt: now,
      },
    ])

    const coordinates = await db
      .select({
        providerId: schema.account.providerId,
        accountId: schema.account.accountId,
      })
      .from(schema.account)
    expect(
      coordinates
        .map(({ providerId, accountId }) => `${providerId}/${accountId}`)
        .sort(),
    ).toEqual([
      'dummy-provider-a/other-account-coordinate',
      'dummy-provider-a/shared-account-coordinate',
      'dummy-provider-b/shared-account-coordinate',
    ])
  })

  test('allows only one of two users to claim the same provider account concurrently', async () => {
    const db = requireDatabase().db
    const now = new Date('2026-08-01T01:00:00.000Z')
    await db.insert(schema.user).values([
      {
        id: 'provider-owner-a',
        name: '所有者A',
        email: 'provider-owner-a@example.test',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'provider-owner-b',
        name: '所有者B',
        email: 'provider-owner-b@example.test',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ])

    const results = await Promise.allSettled([
      db.insert(schema.account).values({
        id: 'provider-account-claim-a',
        accountId: 'shared-provider-account-marker',
        providerId: 'dummy-provider-marker',
        userId: 'provider-owner-a',
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(schema.account).values({
        id: 'provider-account-claim-b',
        accountId: 'shared-provider-account-marker',
        providerId: 'dummy-provider-marker',
        userId: 'provider-owner-b',
        createdAt: now,
        updatedAt: now,
      }),
    ])

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1)
    const accounts = await db
      .select({ userId: schema.account.userId })
      .from(schema.account)
    expect(accounts).toHaveLength(1)
  })
})
