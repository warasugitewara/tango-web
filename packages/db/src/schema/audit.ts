import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.generated'
import { principals } from './principals'

/**
 * 監査メタデータに入れてはいけないキー。
 * 学習内容そのもの (カードの表裏・本文・メモ) は監査ログに残さない。
 * アプリ側の実装ミスを握り潰さないよう、DBのCHECK制約でも拒否する。
 */
export const AUDIT_REDACTED_METADATA_KEYS = [
  'front',
  'back',
  'content',
  'note',
  'notes',
  'text',
  'answer',
  'question',
] as const

/** CHECK制約に埋め込むリテラル配列。要素は上のタプル由来のコンパイル時定数のみ。 */
const REDACTED_KEYS_SQL_ARRAY = `array[${AUDIT_REDACTED_METADATA_KEYS.map(
  (key) => `'${key}'`,
).join(', ')}]::text[]`

export type AuditMetadata = Readonly<Record<string, unknown>>

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    actorPrincipalId: uuid('actor_principal_id').references(
      () => principals.id,
      { onDelete: 'set null' },
    ),
    actorUserId: text('actor_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    requestId: text('request_id').notNull(),
    eventType: text('event_type').notNull(),
    metadata: jsonb('metadata')
      .$type<AuditMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'audit_logs_metadata_redaction_check',
      // drizzle-kitはバインドパラメータをDDLへ展開できないため、
      // コンパイル時定数のキー一覧をリテラルとして埋め込む。
      sql`not jsonb_exists_any(${table.metadata}, ${sql.raw(REDACTED_KEYS_SQL_ARRAY)})`,
    ),
    index('audit_logs_created_at_idx').on(table.createdAt),
    index('audit_logs_actor_principal_id_idx').on(table.actorPrincipalId),
  ],
)
