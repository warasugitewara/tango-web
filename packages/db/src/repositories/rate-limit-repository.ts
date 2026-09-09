import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { Database } from '../client'
import { rateLimitHits } from '../schema/operations'

export interface RateLimitRepository {
  /** 指定時刻以降の試行回数。境界の時刻そのものは数に含める。 */
  countSince(bucket: string, fingerprint: string, since: Date): Promise<number>
  /** 試行を1件記録する。 */
  record(bucket: string, fingerprint: string, now: Date): Promise<void>
  /** 指定時刻より前の記録を消す。消した件数を返す。 */
  purgeBefore(before: Date): Promise<number>
}

export function createRateLimitRepository(db: Database): RateLimitRepository {
  return {
    async countSince(bucket, fingerprint, since) {
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(rateLimitHits)
        .where(
          and(
            eq(rateLimitHits.bucket, bucket),
            eq(rateLimitHits.fingerprint, fingerprint),
            gte(rateLimitHits.occurredAt, since),
          ),
        )

      return row?.value ?? 0
    },

    async record(bucket, fingerprint, now) {
      await db.insert(rateLimitHits).values({
        id: uuidv7(),
        bucket,
        fingerprint,
        occurredAt: now,
      })
    },

    async purgeBefore(before) {
      const rows = await db
        .delete(rateLimitHits)
        .where(lt(rateLimitHits.occurredAt, before))
        .returning({ id: rateLimitHits.id })

      return rows.length
    },
  }
}
