import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** 全ての時刻はTIMESTAMPTZで保持し、表示時にJSTへ変換する。 */
function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' })
}

/**
 * 濫用対策のための試行記録。
 * 1回の試行につき1行を追記し、直近の窓に入る件数で判定する。
 *
 * `fingerprint` にはIPそのものを入れない。呼び出し側がHMACにしてから渡す。
 * 生のIPを残すと、濫用対策のための記録が個人の追跡記録になってしまう。
 */
export const rateLimitHits = pgTable(
  'rate_limit_hits',
  {
    id: uuid('id').primaryKey(),
    /** 制限の対象を表す名前。経路ごとに別々の枠を持たせる。 */
    bucket: text('bucket').notNull(),
    /** 送信元を表すHMAC。復元できない形にしてから保存する。 */
    fingerprint: text('fingerprint').notNull(),
    occurredAt: instant('occurred_at').notNull(),
  },
  (table) => [
    // 判定は「バケットと指紋で絞って、時刻で範囲を切る」形になる。
    index('rate_limit_hits_lookup_idx').on(
      table.bucket,
      table.fingerprint,
      table.occurredAt,
    ),
    // 掃除は時刻だけで走査する。
    index('rate_limit_hits_occurred_at_idx').on(table.occurredAt),
  ],
)
