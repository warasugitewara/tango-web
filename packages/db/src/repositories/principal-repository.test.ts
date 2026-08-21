import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import * as schema from '../schema'
import {
  createTestDatabase,
  resetIdentityTables,
  type TestDatabaseHandle,
} from '../test/database'
import {
  createPrincipalRepository,
  IdentityMergeKeyConflictError,
  type PrincipalRepository,
} from './principal-repository'

const GUEST_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

/** 並行トランザクションの進行順を固定するための一度きりの合図。 */
function createGate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

describe('PrincipalRepository', () => {
  let handle: TestDatabaseHandle | undefined
  let repository: PrincipalRepository

  function database(): TestDatabaseHandle {
    if (handle === undefined) {
      throw new Error('テストDBが初期化されていません。')
    }
    return handle
  }

  beforeAll(async () => {
    handle = await createTestDatabase()
    repository = createPrincipalRepository(database().db)
  })

  afterAll(async () => {
    await handle?.close()
  })

  beforeEach(async () => {
    await resetIdentityTables(database())
  })

  /** Better Authが作る正式ユーザー行を模して1件挿入する。 */
  async function insertFormalUser(now: Date): Promise<string> {
    const id = randomUUID()
    await database()
      .db.insert(schema.user)
      .values({
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
    const [guestPrincipal] = await database()
      .db.select()
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
    const mergeKey = uuidv7()

    const merged = await repository.completeIdentity({
      userId,
      guestTokenHash: input.tokenHash,
      mergeKey,
      now,
    })

    expect(created.outcome).toBe('created')
    expect(merged.outcome).toBe('merged')
    expect(merged.principal.id).toBe(created.principal.id)
    expect(
      await repository.findActiveGuestByTokenHash(input.tokenHash, now),
    ).toBeNull()

    // 取り込み元のゲストprincipalは残さない。
    const remaining = await database()
      .db.select({ id: schema.principals.id })
      .from(schema.principals)
    expect(remaining.map((row) => row.id)).toEqual([created.principal.id])

    // 従属する行もcascadeで消える。
    const orphanSessions = await database()
      .db.select({ id: schema.guestSessions.id })
      .from(schema.guestSessions)
      .where(eq(schema.guestSessions.principalId, guest.principalId))
    expect(orphanSessions).toHaveLength(0)

    const orphanSettings = await database()
      .db.select({ principalId: schema.userSettings.principalId })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.principalId, guest.principalId))
    expect(orphanSettings).toHaveLength(0)

    // 統合の事実そのものは identity_merges に残る。
    const [merge] = await database()
      .db.select({
        sourcePrincipalId: schema.identityMerges.sourcePrincipalId,
        sourceGuestTokenHash: schema.identityMerges.sourceGuestTokenHash,
        targetPrincipalId: schema.identityMerges.targetPrincipalId,
      })
      .from(schema.identityMerges)
      .where(eq(schema.identityMerges.mergeKey, mergeKey))

    // 取り込み元を削除するため source_principal_id は ON DELETE SET NULL でNULLになる。
    expect(merge?.sourcePrincipalId).toBeNull()
    expect(merge?.sourceGuestTokenHash).toBe(input.tokenHash)
    expect(merge?.targetPrincipalId).toBe(created.principal.id)
  })

  test('moves decks and study history to the target principal on merge', async () => {
    const now = new Date()
    const userId = await insertFormalUser(now)
    const created = await repository.completeIdentity({
      userId,
      guestTokenHash: null,
      mergeKey: uuidv7(),
      now,
    })

    // ゲスト側に学習データを作ってから統合する。
    const input = guestInput(now)
    const guest = await repository.createGuest(input)
    const deckId = uuidv7()
    await database().db.insert(schema.decks).values({
      id: deckId,
      principalId: guest.principalId,
      name: '英単語',
      normalizedName: '英単語',
    })
    const cardId = uuidv7()
    await database().db.insert(schema.cards).values({
      id: cardId,
      deckId,
      front: '表',
      back: '裏',
      contentHash: 'hash',
    })

    const merged = await repository.completeIdentity({
      userId,
      guestTokenHash: input.tokenHash,
      mergeKey: uuidv7(),
      now,
    })

    expect(merged.outcome).toBe('merged')

    // 取り込み元principalは消えるが、デッキとカードは取り込み先へ移る。
    const [deck] = await database().db
      .select({ principalId: schema.decks.principalId })
      .from(schema.decks)
    expect(deck?.principalId).toBe(created.principal.id)

    const remainingCards = await database().db
      .select({ id: schema.cards.id })
      .from(schema.cards)
    expect(remainingCards.map((row) => row.id)).toEqual([cardId])
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

  test('returns existing for the same guest hash after promotion removes the active session', async () => {
    const now = new Date()
    const input = guestInput(now)
    const guest = await repository.createGuest(input)
    const userId = await insertFormalUser(now)
    const mergeKey = uuidv7()

    const first = await repository.completeIdentity({
      userId,
      guestTokenHash: input.tokenHash,
      mergeKey,
      now,
    })
    const replayed = await repository.completeIdentity({
      userId,
      guestTokenHash: input.tokenHash,
      mergeKey,
      now,
    })

    expect(first.outcome).toBe('promoted')
    expect(replayed.outcome).toBe('existing')
    expect(replayed.principal.id).toBe(guest.principalId)
    expect(
      await repository.findActiveGuestByTokenHash(input.tokenHash, now),
    ).toBeNull()
  })

  test('rejects a different active guest for the same merge key without consuming it', async () => {
    const now = new Date()
    const firstInput = guestInput(now)
    const secondInput = guestInput(now)
    await repository.createGuest(firstInput)
    const secondGuest = await repository.createGuest(secondInput)
    const userId = await insertFormalUser(now)
    const mergeKey = uuidv7()

    await repository.completeIdentity({
      userId,
      guestTokenHash: firstInput.tokenHash,
      mergeKey,
      now,
    })

    await expect(
      repository.completeIdentity({
        userId,
        guestTokenHash: secondInput.tokenHash,
        mergeKey,
        now,
      }),
    ).rejects.toBeInstanceOf(IdentityMergeKeyConflictError)

    const preserved = await repository.findActiveGuestByTokenHash(
      secondInput.tokenHash,
      now,
    )
    expect(preserved?.principalId).toBe(secondGuest.principalId)
  })

  test('rejects a missing guest hash when the merge key was bound to a guest', async () => {
    const now = new Date()
    const input = guestInput(now)
    await repository.createGuest(input)
    const userId = await insertFormalUser(now)
    const mergeKey = uuidv7()

    await repository.completeIdentity({
      userId,
      guestTokenHash: input.tokenHash,
      mergeKey,
      now,
    })

    await expect(
      repository.completeIdentity({
        userId,
        guestTokenHash: null,
        mergeKey,
        now,
      }),
    ).rejects.toBeInstanceOf(IdentityMergeKeyConflictError)
  })

  test('rejects a guest hash when the merge key was bound to no guest', async () => {
    const now = new Date()
    const input = guestInput(now)
    const guest = await repository.createGuest(input)
    const userId = await insertFormalUser(now)
    const mergeKey = uuidv7()

    await repository.completeIdentity({
      userId,
      guestTokenHash: null,
      mergeKey,
      now,
    })

    await expect(
      repository.completeIdentity({
        userId,
        guestTokenHash: input.tokenHash,
        mergeKey,
        now,
      }),
    ).rejects.toBeInstanceOf(IdentityMergeKeyConflictError)

    const preserved = await repository.findActiveGuestByTokenHash(
      input.tokenHash,
      now,
    )
    expect(preserved?.principalId).toBe(guest.principalId)
  })

  test('binds an inactive guest hash even when no active source can be merged', async () => {
    const now = new Date()
    const expiredInput = guestInput(
      new Date(now.getTime() - GUEST_LIFETIME_MS * 2),
    )
    await repository.createGuest(expiredInput)
    const userId = await insertFormalUser(now)
    const mergeKey = uuidv7()

    const first = await repository.completeIdentity({
      userId,
      guestTokenHash: expiredInput.tokenHash,
      mergeKey,
      now,
    })
    const replayed = await repository.completeIdentity({
      userId,
      guestTokenHash: expiredInput.tokenHash,
      mergeKey,
      now,
    })

    expect(first.outcome).toBe('created')
    expect(replayed.outcome).toBe('existing')

    await expect(
      repository.completeIdentity({
        userId,
        guestTokenHash: `hash-${randomUUID()}`,
        mergeKey,
        now,
      }),
    ).rejects.toBeInstanceOf(IdentityMergeKeyConflictError)
  })

  test('refuses to hand another user the principal recorded for a merge key', async () => {
    const now = new Date()
    const ownerId = await insertFormalUser(now)
    const otherId = await insertFormalUser(now)
    const mergeKey = uuidv7()

    const owned = await repository.completeIdentity({
      userId: ownerId,
      guestTokenHash: null,
      mergeKey,
      now,
    })

    // 他人の冪等性キーを送っても、その人のprincipalは受け取れない。
    await expect(
      repository.completeIdentity({
        userId: otherId,
        guestTokenHash: null,
        mergeKey,
        now,
      }),
    ).rejects.toBeInstanceOf(IdentityMergeKeyConflictError)

    // 送り付けた側にprincipalは作られない。
    expect(await repository.findByUserId(otherId)).toBeNull()
    expect((await repository.findByUserId(ownerId))?.id).toBe(
      owned.principal.id,
    )
  })

  test('rejects a merge key that is not a UUID', async () => {
    // 列の型がUUIDなので、UUID以外の冪等性キーはDBが受け付けない。
    const now = new Date()
    const userId = await insertFormalUser(now)

    await expect(
      repository.completeIdentity({
        userId,
        guestTokenHash: null,
        mergeKey: 'not-a-uuid',
        now,
      }),
    ).rejects.toThrow()
  })

  test('rejects a second live guest session for the same principal', async () => {
    const now = new Date()
    const guest = await repository.createGuest(guestInput(now))

    await expect(
      database()
        .db.insert(schema.guestSessions)
        .values({
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

  test('purges only guests whose session has already expired', async () => {
    const now = new Date()
    const expired = guestInput(new Date(now.getTime() - GUEST_LIFETIME_MS * 2))
    const expiredGuest = await repository.createGuest(expired)
    const liveGuest = await repository.createGuest(guestInput(now))

    const result = await repository.purgeExpiredGuests({ now, limit: 10 })

    expect(result.deletedPrincipals).toBe(1)
    const remaining = await database()
      .db.select({ id: schema.principals.id })
      .from(schema.principals)
    expect(remaining.map((row) => row.id)).toEqual([liveGuest.principalId])
    expect(remaining.map((row) => row.id)).not.toContain(
      expiredGuest.principalId,
    )
  })

  test('never purges a guest whose expiry is extended concurrently', async () => {
    const now = new Date()
    const expired = guestInput(new Date(now.getTime() - GUEST_LIFETIME_MS * 2))
    const guest = await repository.createGuest(expired)

    // 延長トランザクションを開いたまま掃除を走らせ、
    // 「選定は期限切れ、削除の直前に延長」という競合状態を再現する。
    const locked = createGate()
    const release = createGate()

    const extension = database().db.transaction(async (tx) => {
      await tx
        .update(schema.guestSessions)
        .set({
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + GUEST_LIFETIME_MS),
          updatedAt: now,
        })
        .where(eq(schema.guestSessions.id, guest.id))
      locked.open()
      await release.wait
    })

    await locked.wait
    const result = await repository.purgeExpiredGuests({ now, limit: 10 })
    release.open()
    await extension

    // 更新中の行は SKIP LOCKED で見送られ、利用中のゲストは残る。
    expect(result.deletedPrincipals).toBe(0)
    const survivor = await repository.findActiveGuestByTokenHash(
      expired.tokenHash,
      now,
    )
    expect(survivor?.principalId).toBe(guest.principalId)

    // 延長が確定したあとの掃除でも対象外のまま。
    const afterCommit = await repository.purgeExpiredGuests({ now, limit: 10 })
    expect(afterCommit.deletedPrincipals).toBe(0)
  })
})
