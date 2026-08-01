import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { Database, DatabaseTransaction } from '../client'
import {
  guestSessions,
  identityMerges,
  type PrincipalKind,
  principals,
  userSettings,
} from '../schema'

export type PrincipalRecord = {
  id: string
  kind: PrincipalKind
  userId: string | null
  createdAt: Date
  updatedAt: Date
}

export type GuestSessionRecord = {
  id: string
  principalId: string
  tokenHash: string
  lastSeenAt: Date
  expiresAt: Date
  revokedAt: Date | null
}

export type IdentityCompletionOutcome =
  | 'created'
  | 'promoted'
  | 'merged'
  | 'existing'

export type IdentityCompletionResult = {
  principal: PrincipalRecord
  outcome: IdentityCompletionOutcome
}

export type PurgeExpiredGuestsResult = {
  /** 実際に削除されたゲストprincipalの件数。 */
  deletedPrincipals: number
}

export interface PrincipalRepository {
  findByUserId(userId: string): Promise<PrincipalRecord | null>
  findActiveGuestByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<GuestSessionRecord | null>
  createGuest(input: {
    tokenHash: string
    now: Date
    expiresAt: Date
  }): Promise<GuestSessionRecord>
  completeIdentity(input: {
    userId: string
    guestTokenHash: string | null
    mergeKey: string
    now: Date
  }): Promise<IdentityCompletionResult>
  touchGuest(input: {
    sessionId: string
    now: Date
    expiresAt: Date
  }): Promise<void>
  revokeGuest(sessionId: string, now: Date): Promise<void>
  purgeExpiredGuests(input: {
    now: Date
    limit: number
  }): Promise<PurgeExpiredGuestsResult>
}

/** PostgreSQLの一意制約違反。 */
const UNIQUE_VIOLATION = '23505'

const MAX_UNIQUE_CONFLICT_ATTEMPTS = 5

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error

  for (
    let depth = 0;
    depth < 5 && current !== null && current !== undefined;
    depth += 1
  ) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      current.code === UNIQUE_VIOLATION
    ) {
      return true
    }

    current = current instanceof Error ? current.cause : null
  }

  return false
}

/**
 * 一意制約の衝突だけをトランザクション単位で再試行する。
 * アプリ内ロックを持たず、DBの一意制約を唯一の直列化点にする。
 */
async function withUniqueConflictRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < MAX_UNIQUE_CONFLICT_ATTEMPTS; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error
      }
      lastError = error
    }
  }

  throw lastError
}

type PrincipalRow = typeof principals.$inferSelect
type GuestSessionRow = typeof guestSessions.$inferSelect

function toPrincipalRecord(row: PrincipalRow): PrincipalRecord {
  return {
    id: row.id,
    kind: row.kind,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toGuestSessionRecord(row: GuestSessionRow): GuestSessionRecord {
  return {
    id: row.id,
    principalId: row.principalId,
    tokenHash: row.tokenHash,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  }
}

async function findPrincipalById(
  tx: DatabaseTransaction,
  principalId: string,
): Promise<PrincipalRecord | null> {
  const [row] = await tx
    .select()
    .from(principals)
    .where(eq(principals.id, principalId))
    .limit(1)

  return row === undefined ? null : toPrincipalRecord(row)
}

/** principalごとの学習設定を既定値で用意する。既にあれば何もしない。 */
async function ensureUserSettings(
  tx: DatabaseTransaction,
  principalId: string,
): Promise<void> {
  await tx
    .insert(userSettings)
    .values({ principalId })
    .onConflictDoNothing({ target: userSettings.principalId })
}

/**
 * ゲストprincipalが所有するドメイン行を正式principalへ移す拡張点。
 * `completeIdentity` と同じトランザクション内で呼ばれる。
 * Phase 1ではデッキやカードのテーブルがまだ無いため移送対象は存在せず、
 * 統合の事実は同トランザクションの `identity_merges` 行が記録する。
 * Phase 2でテーブルを追加する際は、この関数の中だけを拡張すれば原子性が保たれる。
 */
export async function moveOwnedDomainRows(
  sourcePrincipalId: string,
  targetPrincipalId: string,
  _tx: DatabaseTransaction,
): Promise<void> {
  if (sourcePrincipalId === targetPrincipalId) {
    return
  }
  // Phase 1: 移送対象のドメインテーブルはまだ存在しない。
}

export function createPrincipalRepository(db: Database): PrincipalRepository {
  return {
    async findByUserId(userId) {
      const [row] = await db
        .select()
        .from(principals)
        .where(eq(principals.userId, userId))
        .limit(1)

      return row === undefined ? null : toPrincipalRecord(row)
    },

    async findActiveGuestByTokenHash(tokenHash, now) {
      const [row] = await db
        .select()
        .from(guestSessions)
        .where(
          and(
            eq(guestSessions.tokenHash, tokenHash),
            isNull(guestSessions.revokedAt),
            gt(guestSessions.expiresAt, now),
          ),
        )
        .limit(1)

      return row === undefined ? null : toGuestSessionRecord(row)
    },

    async createGuest({ tokenHash, now, expiresAt }) {
      return db.transaction(async (tx) => {
        const principalId = uuidv7()

        await tx.insert(principals).values({
          id: principalId,
          kind: 'guest',
          createdAt: now,
          updatedAt: now,
        })
        await ensureUserSettings(tx, principalId)

        const [row] = await tx
          .insert(guestSessions)
          .values({
            id: uuidv7(),
            principalId,
            tokenHash,
            lastSeenAt: now,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning()

        if (row === undefined) {
          throw new Error('ゲストセッションの作成に失敗しました。')
        }

        return toGuestSessionRecord(row)
      })
    },

    async completeIdentity({ userId, guestTokenHash, mergeKey, now }) {
      return withUniqueConflictRetry(() =>
        db.transaction(async (tx): Promise<IdentityCompletionResult> => {
          // 1. 同じ冪等性キーで完了済みなら、その結果をそのまま返す。
          const [recordedMerge] = await tx
            .select()
            .from(identityMerges)
            .where(eq(identityMerges.mergeKey, mergeKey))
            .limit(1)

          if (recordedMerge !== undefined) {
            const principal = await findPrincipalById(
              tx,
              recordedMerge.targetPrincipalId,
            )

            if (principal !== null) {
              return { principal, outcome: 'existing' }
            }
          }

          // 2. 既存の正式principalと、有効なゲストセッションを取得する。
          const [formalRow] = await tx
            .select()
            .from(principals)
            .where(eq(principals.userId, userId))
            .limit(1)

          const [guestRow] =
            guestTokenHash === null
              ? []
              : await tx
                  .select()
                  .from(guestSessions)
                  .where(
                    and(
                      eq(guestSessions.tokenHash, guestTokenHash),
                      isNull(guestSessions.revokedAt),
                      gt(guestSessions.expiresAt, now),
                    ),
                  )
                  .limit(1)

          const revokeGuestSession = async (): Promise<void> => {
            if (guestRow === undefined) {
              return
            }
            await tx
              .update(guestSessions)
              .set({ revokedAt: now, updatedAt: now })
              .where(eq(guestSessions.id, guestRow.id))
          }

          const recordMerge = async (
            targetPrincipalId: string,
            sourcePrincipalId: string | null,
          ): Promise<void> => {
            await tx.insert(identityMerges).values({
              id: uuidv7(),
              mergeKey,
              sourcePrincipalId,
              targetPrincipalId,
              status: 'completed',
              createdAt: now,
              completedAt: now,
            })
          }

          // 3a. 正式principalが既にある。
          if (formalRow !== undefined) {
            const isSeparateGuest =
              guestRow !== undefined && guestRow.principalId !== formalRow.id

            if (isSeparateGuest) {
              await moveOwnedDomainRows(guestRow.principalId, formalRow.id, tx)
              await revokeGuestSession()
              await recordMerge(formalRow.id, guestRow.principalId)
              return {
                principal: toPrincipalRecord(formalRow),
                outcome: 'merged',
              }
            }

            await revokeGuestSession()
            await recordMerge(formalRow.id, null)
            return {
              principal: toPrincipalRecord(formalRow),
              outcome: 'existing',
            }
          }

          // 3b. 有効なゲストがいるなら、その行をそのまま正式principalへ昇格する。
          if (guestRow !== undefined) {
            const [promoted] = await tx
              .update(principals)
              .set({ kind: 'user', userId, updatedAt: now })
              .where(eq(principals.id, guestRow.principalId))
              .returning()

            if (promoted === undefined) {
              throw new Error('ゲストprincipalの昇格に失敗しました。')
            }

            await revokeGuestSession()
            await recordMerge(promoted.id, null)
            return {
              principal: toPrincipalRecord(promoted),
              outcome: 'promoted',
            }
          }

          // 3c. ゲストがいない新規ユーザー。
          const [created] = await tx
            .insert(principals)
            .values({
              id: uuidv7(),
              kind: 'user',
              userId,
              createdAt: now,
              updatedAt: now,
            })
            .returning()

          if (created === undefined) {
            throw new Error('正式principalの作成に失敗しました。')
          }

          await ensureUserSettings(tx, created.id)
          await recordMerge(created.id, null)
          return { principal: toPrincipalRecord(created), outcome: 'created' }
        }),
      )
    },

    async touchGuest({ sessionId, now, expiresAt }) {
      await db
        .update(guestSessions)
        .set({ lastSeenAt: now, expiresAt, updatedAt: now })
        .where(
          and(eq(guestSessions.id, sessionId), isNull(guestSessions.revokedAt)),
        )
    },

    async revokeGuest(sessionId, now) {
      await db
        .update(guestSessions)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(eq(guestSessions.id, sessionId), isNull(guestSessions.revokedAt)),
        )
    },

    async purgeExpiredGuests({ now, limit }) {
      // 正式ユーザーが紐づいたprincipalは kind='user' かつ user_id が非NULLになるため、
      // ここで選ばれることはない。所有データはFKのcascadeで一緒に消える。
      const candidates = await db
        .select({ id: principals.id })
        .from(principals)
        .innerJoin(guestSessions, eq(guestSessions.principalId, principals.id))
        .where(
          and(
            eq(principals.kind, 'guest'),
            isNull(principals.userId),
            lte(guestSessions.expiresAt, now),
          ),
        )
        .limit(limit)

      if (candidates.length === 0) {
        return { deletedPrincipals: 0 }
      }

      const deleted = await db
        .delete(principals)
        .where(
          and(
            inArray(
              principals.id,
              candidates.map((row) => row.id),
            ),
            eq(principals.kind, 'guest'),
            isNull(principals.userId),
          ),
        )
        .returning({ id: principals.id })

      return { deletedPrincipals: deleted.length }
    },
  }
}
