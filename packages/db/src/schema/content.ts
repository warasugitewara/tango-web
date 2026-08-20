import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { principals } from './principals'

/** 全ての時刻はTIMESTAMPTZで保持し、表示時にJSTへ変換する。 */
function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' })
}

export const CARD_STATUSES = ['active', 'suspended'] as const
export type CardStatus = (typeof CARD_STATUSES)[number]

export type CardMetadata = Readonly<Record<string, unknown>>

/**
 * 学習カードの入れ物。所有者はprincipalで表す。
 * 削除は行を消さず trashed_at を打つ。通常の読み取りからは隠す。
 */
export const decks = pgTable(
  'decks',
  {
    id: uuid('id').primaryKey(),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 重複判定と統合時の突き合わせに使う正規化名。 */
    normalizedName: text('normalized_name').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** 1学習日あたりに出す新規カードの上限。0は新規を出さない。 */
    newCardLimit: integer('new_card_limit').notNull().default(20),
    archivedAt: instant('archived_at'),
    trashedAt: instant('trashed_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'decks_new_card_limit_check',
      sql`${table.newCardLimit} between 0 and 1000`,
    ),
    index('decks_principal_id_idx').on(table.principalId),
    index('decks_trashed_at_idx').on(table.trashedAt),
  ],
)

/**
 * カード本体。生HTMLは受け付けず、Markdownとして保持する。
 * 取り込み元を持つカードは (deck_id, source_key, external_id) で一意になる。
 */
export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey(),
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    front: text('front').notNull(),
    back: text('back').notNull(),
    metadata: jsonb('metadata')
      .$type<CardMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** 正規化した本文のSHA-256。重複検出をPhase 2で足すときに使う。 */
    contentHash: text('content_hash').notNull(),
    status: text('status').$type<CardStatus>().notNull().default('active'),
    sourceKey: text('source_key'),
    externalId: text('external_id'),
    sourceUrl: text('source_url'),
    sourceTitle: text('source_title'),
    trashedAt: instant('trashed_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'cards_status_check',
      sql`${table.status} in ('active', 'suspended')`,
    ),
    index('cards_deck_id_idx').on(table.deckId),
    index('cards_trashed_at_idx').on(table.trashedAt),
    index('cards_content_hash_idx').on(table.contentHash),
    // 取り込み元IDを持つカードだけ一意にする。手入力カードは重複できる。
    uniqueIndex('cards_external_identity_uidx')
      .on(table.deckId, table.sourceKey, table.externalId)
      .where(
        sql`${table.sourceKey} is not null and ${table.externalId} is not null`,
      ),
  ],
)
