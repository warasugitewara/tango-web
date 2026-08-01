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
  /** 期限を延長できたときだけ true。取り消し済み・不在の場合は false。 */
  touchGuest(input: {
    sessionId: string
    now: Date
    expiresAt: Date
  }): Promise<boolean>
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

/**
 * principal行をIDで排他ロックする。
 * READ COMMITTEDではロック取得時に最新版へ再評価されるため、
 * 取得後の値をそのまま呼び出し側の再確認に使える。
 */
async function lockPrincipalById(
  tx: DatabaseTransaction,
  principalId: string,
): Promise<PrincipalRow | undefined> {
  const [row] = await tx
    .select()
    .from(principals)
    .where(eq(principals.id, principalId))
    .limit(1)
    .for('update')

  return row
}

/** ゲストセッション行をIDで排他ロックする。有効性の判定はロック後に行う。 */
async function lockGuestSessionById(
  tx: DatabaseTransaction,
  sessionId: string,
): Promise<GuestSessionRow | undefined> {
  const [row] = await tx
    .select()
    .from(guestSessions)
    .where(eq(guestSessions.id, sessionId))
    .limit(1)
    .for('update')

  return row
}

/**
 * 取り込み対象として確定したゲスト。
 * セッションとprincipalの双方をロック済みで、有効性の再確認も済んでいる。
 */
type LockedGuest = {
  session: GuestSessionRow
  principal: PrincipalRow
}

/**
 * ゲストセッションとそのprincipalをこの順序でロックし、有効性を再確認する。
 * 並行して取り消し・期限切れ・昇格済みになっていた場合は null を返し、
 * 取り込み対象から外す。
 */
async function lockActiveGuest(
  tx: DatabaseTransaction,
  tokenHash: string,
  now: Date,
): Promise<LockedGuest | null> {
  const [candidate] = await tx
    .select({ id: guestSessions.id })
    .from(guestSessions)
    .where(eq(guestSessions.tokenHash, tokenHash))
    .limit(1)

  if (candidate === undefined) {
    return null
  }

  const session = await lockGuestSessionById(tx, candidate.id)

  if (
    session === undefined ||
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= now.getTime()
  ) {
    return null
  }

  const principal = await lockPrincipalById(tx, session.principalId)

  // 昇格済み・別ユーザーに割り当て済みのprincipalは取り込まない。
  if (
    principal === undefined ||
    principal.kind !== 'guest' ||
    principal.userId !== null
  ) {
    return null
  }

  return { session, principal }
}

/** 正式principalをロックし、対象ユーザーのものであることを再確認する。 */
async function lockFormalPrincipal(
  tx: DatabaseTransaction,
  userId: string,
): Promise<PrincipalRow | undefined> {
  const [candidate] = await tx
    .select({ id: principals.id })
    .from(principals)
    .where(eq(principals.userId, userId))
    .limit(1)

  if (candidate === undefined) {
    return undefined
  }

  const locked = await lockPrincipalById(tx, candidate.id)

  return locked !== undefined && locked.userId === userId ? locked : undefined
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

          // 2. 対象行を決まった順序でロックする。
          //    ゲストセッション → ゲストprincipal → 正式principal に固定し、
          //    逆順のロック要求が生じないようにしてデッドロックを避ける。
          //    ロック取得後に有効性・kind・userIdを再確認するので、
          //    同じトークンを別ユーザーが並行して使っても取り込みは一度きりになる。
          const guest =
            guestTokenHash === null
              ? null
              : await lockActiveGuest(tx, guestTokenHash, now)

          const formalRow = await lockFormalPrincipal(tx, userId)

          const revokeGuestSession = async (): Promise<void> => {
            if (guest === null) {
              return
            }
            await tx
              .update(guestSessions)
              .set({ revokedAt: now, updatedAt: now })
              .where(eq(guestSessions.id, guest.session.id))
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
            if (guest !== null && guest.principal.id !== formalRow.id) {
              await moveOwnedDomainRows(guest.principal.id, formalRow.id, tx)
              await revokeGuestSession()
              await recordMerge(formalRow.id, guest.principal.id)
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
          if (guest !== null) {
            const [promoted] = await tx
              .update(principals)
              .set({ kind: 'user', userId, updatedAt: now })
              // ロック済みでも条件を明示し、ゲストのままの行だけを昇格する。
              // 万一先に別ユーザーへ割り当てられていたらUPDATEは0件になり、
              // 例外でトランザクション全体を巻き戻して上書きを防ぐ。
              .where(
                and(
                  eq(principals.id, guest.principal.id),
                  eq(principals.kind, 'guest'),
                  isNull(principals.userId),
                ),
              )
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
      const updated = await db
        .update(guestSessions)
        .set({ lastSeenAt: now, expiresAt, updatedAt: now })
        .where(
          and(eq(guestSessions.id, sessionId), isNull(guestSessions.revokedAt)),
        )
        .returning({ id: guestSessions.id })

      return updated.length > 0
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
