import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.generated'

/** 全ての時刻はTIMESTAMPTZで保持し、表示時にJSTへ変換する。 */
function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' })
}

export const PRINCIPAL_KINDS = ['guest', 'user'] as const
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number]

export const IDENTITY_MERGE_STATUSES = [
  'pending',
  'completed',
  'failed',
] as const
export type IdentityMergeStatus = (typeof IDENTITY_MERGE_STATUSES)[number]

/**
 * 学習データの所有者。ゲストも正式ユーザーもこの1テーブルで表す。
 * ゲストから正式ユーザーへの昇格は行のkind/user_idを更新するだけで済む。
 */
export const principals = pgTable(
  'principals',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').$type<PrincipalKind>().notNull(),
    userId: text('user_id')
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('principals_kind_check', sql`${table.kind} in ('guest', 'user')`),
    // kindとuser_idの整合をDBで保証する。ゲストはuser_idを持たない。
    check(
      'principals_kind_user_id_check',
      sql`(${table.kind} = 'user') = (${table.userId} is not null)`,
    ),
  ],
)

/**
 * ゲストの生存セッション。1つのゲストprincipalにつき常に1行だけ存在する。
 * 生トークンは保存せず、ハッシュのみを保持する。
 */
export const guestSessions = pgTable(
  'guest_sessions',
  {
    id: uuid('id').primaryKey(),
    principalId: uuid('principal_id')
      .notNull()
      .unique()
      .references(() => principals.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    lastSeenAt: instant('last_seen_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // 期限切れセッションの掃除ジョブが全走査しないようにする。
    index('guest_sessions_expires_at_idx').on(table.expiresAt),
  ],
)

/** 学習設定。principalごとに高々1行。 */
export const userSettings = pgTable(
  'user_settings',
  {
    principalId: uuid('principal_id')
      .primaryKey()
      .references(() => principals.id, { onDelete: 'cascade' }),
    desiredRetention: numeric('desired_retention', { precision: 5, scale: 4 })
      .notNull()
      .default('0.9000'),
    showProgressByDefault: boolean('show_progress_by_default')
      .notNull()
      .default(true),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'user_settings_desired_retention_check',
      sql`${table.desiredRetention} between 0.70 and 0.97`,
    ),
  ],
)

/**
 * ゲストから正式ユーザーへの統合記録。merge_keyが冪等性キーになる。
 * 同じmerge_keyでの再試行は新しい統合を起こさない。
 */
export const identityMerges = pgTable(
  'identity_merges',
  {
    id: uuid('id').primaryKey(),
    /** OAuthコールバックごとに一意なUUIDv7。型でUUID以外の値を弾く。 */
    mergeKey: uuid('merge_key').notNull().unique(),
    sourcePrincipalId: uuid('source_principal_id').references(
      () => principals.id,
      { onDelete: 'set null' },
    ),
    /** source principal削除後も再送元を照合できるHMAC-SHA-256 fingerprint。 */
    sourceGuestTokenHash: text('source_guest_token_hash'),
    targetPrincipalId: uuid('target_principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    status: text('status').$type<IdentityMergeStatus>().notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    completedAt: instant('completed_at'),
  },
  (table) => [
    check(
      'identity_merges_status_check',
      sql`${table.status} in ('pending', 'completed', 'failed')`,
    ),
    index('identity_merges_target_principal_id_idx').on(
      table.targetPrincipalId,
    ),
  ],
)
