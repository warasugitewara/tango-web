import { sql } from 'drizzle-orm'
import {
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.generated'
import { principals } from './principals'

/**
 * 監査メタデータに入れてはいけないキー。
 * 学習内容そのもの (カードの表裏・本文・メモ) と認証情報を監査ログに残さない。
 * アプリ側の実装ミスを握り潰さないよう、DBのCHECK制約でも拒否する。
 */
export const AUDIT_REDACTED_METADATA_KEYS = [
  // 学習内容
  'front',
  'back',
  'content',
  'note',
  'notes',
  'text',
  'answer',
  'question',
  // token / session / credential等の秘密値
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'bearerToken',
  'guestToken',
  'csrfToken',
  'oauthToken',
  'session',
  'sessionId',
  'sessionToken',
  'sessionCookie',
  'cookie',
  'setCookie',
  'cookieHeader',
  'password',
  'secret',
  'clientSecret',
  'oauthCredential',
  'oauthCredentials',
  'credential',
  'credentials',
  'authorization',
  'authorizationCode',
  'apiKey',
  'privateKey',
  'codeVerifier',
  'oauthState',
] as const

/**
 * audit metadataキーの共通正規化規則。
 * ASCII大文字を小文字へ変換し、ASCIIの `_` と `-` だけを除去する。
 * 空白・dot・非ASCII文字は意図的に同一視しない。
 */
function normalizeAuditMetadataKey(key: string): string {
  return key.replace(/[A-Z_-]/gu, (character) => {
    if (character === '_' || character === '-') {
      return ''
    }
    return String.fromCharCode(character.charCodeAt(0) + 32)
  })
}

/**
 * Phase 1共通の安全床。Phase 2で書込みeventを追加する際は、
 * この汎用型をAPI境界へ公開せずevent別allowlist schemaでさらに絞り込む。
 */
export type AuditMetadata = Readonly<Record<string, unknown>>

const REDACTED_METADATA_KEY_SET: ReadonlySet<string> = new Set(
  AUDIT_REDACTED_METADATA_KEYS.map(normalizeAuditMetadataKey),
)

/**
 * 配列内を含む全階層を走査し、学習内容を示すキーをDB送信前に拒否する。
 * エラーにはキー名だけを含め、値を露出させない。
 */
export function assertAuditMetadata(metadata: AuditMetadata): void {
  const pending: unknown[] = [metadata]
  const visited = new WeakSet<object>()

  while (pending.length > 0) {
    const current = pending.pop()
    if (
      typeof current !== 'object' ||
      current === null ||
      visited.has(current)
    ) {
      continue
    }
    visited.add(current)

    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }

    for (const [key, value] of Object.entries(current)) {
      if (REDACTED_METADATA_KEY_SET.has(normalizeAuditMetadataKey(key))) {
        throw new Error(`監査metadataに禁止キー "${key}" が含まれています。`)
      }
      pending.push(value)
    }
  }
}

const auditMetadataJsonb = customType<{
  data: AuditMetadata
  driverData: string
}>({
  dataType: () => 'jsonb',
  toDriver: (metadata) => {
    assertAuditMetadata(metadata)
    const serialized = JSON.stringify(metadata)
    if (serialized === undefined) {
      throw new Error('監査metadataをJSONへ変換できません。')
    }
    return serialized
  },
})

function normalizedKeyToJsonPathPattern(normalizedKey: string): string {
  if (!/^[a-z0-9]+$/u.test(normalizedKey)) {
    throw new Error(
      `監査metadataの禁止キーをJSONPathへ変換できません: ${normalizedKey}`,
    )
  }

  const characters = [...normalizedKey].map((character) => {
    if (/^[a-z]$/u.test(character)) {
      return `[${character}${character.toUpperCase()}]`
    }
    return character
  })

  return `^[_-]*${characters.join('[_-]*')}[_-]*$`
}

/** runtimeと同じASCII case/区切り正規化をDBの全階層キーへ適用するJSONPath。 */
const REDACTED_KEYS_JSON_PATH = `$.** ? (@.type() == "object").keyvalue() ? (${AUDIT_REDACTED_METADATA_KEYS.map(
  (key) =>
    `@.key like_regex "${normalizedKeyToJsonPathPattern(normalizeAuditMetadataKey(key))}"`,
).join(' || ')})`

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
    metadata: auditMetadataJsonb('metadata')
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
      // コンパイル時定数のキー一覧から生成したJSONPathを埋め込む。
      sql`not jsonb_path_exists(${table.metadata}, ${sql.raw(`'${REDACTED_KEYS_JSON_PATH}'::jsonpath`)})`,
    ),
    index('audit_logs_created_at_idx').on(table.createdAt),
    index('audit_logs_actor_principal_id_idx').on(table.actorPrincipalId),
  ],
)
