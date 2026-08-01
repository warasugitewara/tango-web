import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseHandle } from '../client'
import * as schema from '../schema'
import { createTestDatabase, resetIdentityTables } from '../test/database'
import {
  createPrincipalRepository,
  type PrincipalRepository,
} from './principal-repository'

const GUEST_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

describe('PrincipalRepository', () => {
  let handle: DatabaseHandle
  let repository: PrincipalRepository

  beforeAll(async () => {
    handle = await createTestDatabase()
    repository = createPrincipalRepository(handle.db)
  })

  afterAll(async () => {
    await handle.close()
  })

  beforeEach(async () => {
    await resetIdentityTables(handle.db)
  })

  /** Better Authが作る正式ユーザー行を模して1件挿入する。 */
  async function insertFormalUser(now: Date): Promise<string> {
    const id = randomUUID()
    await handle.db.insert(schema.user).values({
      id,
      name: 'テストユーザー',
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    return id
  }

  function guestInput(now: Date) {
    return {
      tokenHash: `hash-${randomUUID()}`,
      now,
      expiresAt: new Date(now.getTime() + GUEST_LIFETIME_MS),
    }
  }

  test('creates one formal principal for a user under concurrent calls', async () => {
    const now = new Date()
    const userId = await insertFormalUser(now)

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.completeIdentity({
          userId,
          guestTokenHash: null,
          mergeKey: uuidv7(),
          now,
        }),
      ),
    )

    const principalIds = new Set(results.map((result) => result.principal.id))
    expect(principalIds.size).toBe(1)
    expect(
      results.filter((result) => result.outcome === 'created'),
    ).toHaveLength(1)

    const stored = await repository.findByUserId(userId)
    expect(stored).not.toBeNull()
    expect(stored?.kind).toBe('user')
    expect(stored?.userId).toBe(userId)
  })

  test('promotes a guest principal when the user has no formal principal', async () => {
    const now = new Date()
    const input = guestInput(now)
    const guest = await repository.createGuest(input)
    const userId = await insertFormalUser(now)

    const result = await repository.completeIdentity({
      userId,
      guestTokenHash: input.tokenHash,
      mergeKey: uuidv7(),
      now,
    })

    expect(result.outcome).toBe('promoted')
    expect(result.principal.id).toBe(guest.principalId)
    expect(result.principal.kind).toBe('user')
    expect(result.principal.userId).toBe(userId)

    // 昇格後のゲストセッションは失効し、再利用できない。
    expect(
      await repository.findActiveGuestByTokenHash(input.tokenHash, now),
    ).toBeNull()
  })

  test('promotes a shared guest token for only one user under concurrent completion', async () => {
    const now = new Date()
    const input = guestInput(now)
    const guest = await repository.createGuest(input)
    const firstUserId = await insertFormalUser(now)
    const secondUserId = await insertFormalUser(now)

    // 同じゲストCookieを2人のユーザーが同時に持ち込んだ状況を作る。
    const results = await Promise.all(
      [firstUserId, secondUserId].map((userId) =>
        repository.completeIdentity({
          userId,
          guestTokenHash: input.tokenHash,
          mergeKey: uuidv7(),
          now,
        }),
      ),
    )

    // ゲストprincipalを取り込めるのは片方だけ。もう片方は自分専用に新規作成する。
    const promoted = results.find((result) => result.outcome === 'promoted')
    const created = results.find((result) => result.outcome === 'created')

    expect(promoted).toBeDefined()
    expect(created).toBeDefined()
    expect(promoted?.principal.id).toBe(guest.principalId)
    expect(created?.principal.id).not.toBe(guest.principalId)

    // 昇格したprincipalのuser_idが後勝ちで上書きされていない。
    const [guestPrincipal] = await handle.db
      .select()
      .from(schema.principals)
      .where(eq(schema.principals.id, guest.principalId))

    expect(guestPrincipal?.kind).toBe('user')
    expect(guestPrincipal?.userId).toBe(promoted?.principal.userId)

    // 2人が同じprincipalを共有しない。
    const first = await repository.findByUserId(firstUserId)
    const second = await repository.findByUserId(secondUserId)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first?.id).not.toBe(second?.id)

    // 取り込みに使われたゲストセッションは失効している。
    expect(
      await repository.findActiveGuestByTokenHash(input.tokenHash, now),
    ).toBeNull()
  })

  test('merges a guest principal into an existing formal principal', async () => {
    const now = new Date()
    const userId = await insertFormalUser(now)
    const created = await repository.completeIdentity({
      userId,
      guestTokenHash: null,
      mergeKey: uuidv7(),
      now,
    })
    const input = guestInput(now)
    const guest = await repository.createGuest(input)

    const merged = await repository.completeIdentity({
      userId,
      guestTokenHash: input.tokenHash,
      mergeKey: uuidv7(),
      now,
    })

    expect(created.outcome).toBe('created')
    expect(merged.outcome).toBe('merged')
    expect(merged.principal.id).toBe(created.principal.id)
    expect(
      await repository.findActiveGuestByTokenHash(input.tokenHash, now),
    ).toBeNull()

    // 取り込み元のゲストprincipalは残さない。
    const remaining = await handle.db
      .select({ id: schema.principals.id })
      .from(schema.principals)
    expect(remaining.map((row) => row.id)).toEqual([created.principal.id])

    // 従属する行もcascadeで消える。
    const orphanSessions = await handle.db
      .select({ id: schema.guestSessions.id })
      .from(schema.guestSessions)
      .where(eq(schema.guestSessions.principalId, guest.principalId))
    expect(orphanSessions).toHaveLength(0)

    const orphanSettings = await handle.db
      .select({ principalId: schema.userSettings.principalId })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.principalId, guest.principalId))
    expect(orphanSettings).toHaveLength(0)

    // 統合の事実そのものは identity_merges に残る。
    const merges = await handle.db
      .select({
        sourcePrincipalId: schema.identityMerges.sourcePrincipalId,
        targetPrincipalId: schema.identityMerges.targetPrincipalId,
      })
      .from(schema.identityMerges)
      .where(eq(schema.identityMerges.targetPrincipalId, created.principal.id))
    expect(merges).toHaveLength(2)
    // 取り込み元を削除するため source_principal_id は ON DELETE SET NULL でNULLになる。
    expect(merges.every((row) => row.sourcePrincipalId === null)).toBe(true)
  })

  test('returns the existing principal when completion is retried', async () => {
    const now = new Date()
    const userId = await insertFormalUser(now)
    const mergeKey = uuidv7()

    const first = await repository.completeIdentity({
      userId,
      guestTokenHash: null,
      mergeKey,
      now,
    })
    const second = await repository.completeIdentity({
      userId,
      guestTokenHash: null,
      mergeKey,
      now,
    })

    expect(first.outcome).toBe('created')
    expect(second.outcome).toBe('existing')
    expect(second.principal.id).toBe(first.principal.id)
  })

  test('rejects a second live guest session for the same principal', async () => {
    const now = new Date()
    const guest = await repository.createGuest(guestInput(now))

    await expect(
      handle.db.insert(schema.guestSessions).values({
        id: uuidv7(),
        principalId: guest.principalId,
        tokenHash: `hash-${randomUUID()}`,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + GUEST_LIFETIME_MS),
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow()
  })

  test('ignores expired and revoked guest sessions when looking up by token hash', async () => {
    const now = new Date()
    const expired = guestInput(new Date(now.getTime() - GUEST_LIFETIME_MS * 2))
    await repository.createGuest(expired)
    expect(
      await repository.findActiveGuestByTokenHash(expired.tokenHash, now),
    ).toBeNull()

    const revoked = guestInput(now)
    const session = await repository.createGuest(revoked)
    await repository.revokeGuest(session.id, now)
    expect(
      await repository.findActiveGuestByTokenHash(revoked.tokenHash, now),
    ).toBeNull()
  })
})
