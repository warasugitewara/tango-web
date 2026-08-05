const GENERATED_HEADER = `/**
 * Better Auth CLI 1.6.25の生成結果へTIMESTAMPTZ変換を適用した生成物。
 * 手で編集せず、bun run db:auth-schema で再生成すること。
 */
`

const RAW_POSTGRES_TIMESTAMP = /timestamp\("([^"]+)"\)/g
const TIMESTAMPTZ = /timestamp\("([^"]+)", \{ withTimezone: true \}\)/g

const EXPECTED_TIMESTAMP_COLUMNS = [
  'access_token_expires_at',
  'created_at',
  'created_at',
  'created_at',
  'created_at',
  'expires_at',
  'expires_at',
  'refresh_token_expires_at',
  'updated_at',
  'updated_at',
  'updated_at',
  'updated_at',
].sort()

const PG_CORE_IMPORT =
  'import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";'
const PG_CORE_IMPORT_WITH_UNIQUE =
  'import { pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";'
const ACCOUNT_INDEX_ANCHOR =
  '  (table) => [index("account_userId_idx").on(table.userId)],\n);'
const ACCOUNT_INDEXES_WITH_UNIQUE = `  (table) => [
    index("account_userId_idx").on(table.userId),
    uniqueIndex("account_providerId_accountId_uidx").on(
      table.providerId,
      table.accountId,
    ),
  ],
);`

function occurrences(value: string, target: string): number {
  return value.split(target).length - 1
}

function replaceExactlyOnce(
  value: string,
  target: string,
  replacement: string,
  label: string,
): string {
  if (occurrences(value, target) !== 1) {
    throw new Error(
      `Better Auth生成結果の${label}が固定CLI出力と一致しません。生成器の変更を確認してください。`,
    )
  }
  return value.replace(target, replacement)
}

function assertExactTimestampColumns(
  columns: readonly string[],
  label: string,
): void {
  const actual = [...columns].sort()
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_TIMESTAMP_COLUMNS)) {
    throw new Error(
      `Better Auth生成結果の${label} timestamp列が期待する12列と一致しません。生成器の変更を確認してください。`,
    )
  }
}

/**
 * Better Auth 1.6.25のDrizzle生成器が出すPostgreSQL Date列を、
 * 製品のinstant契約どおりTIMESTAMPTZへ決定的に変換する。
 */
export function transformBetterAuthPostgresSchema(generated: string): string {
  const rawTimestampColumns = Array.from(
    generated.matchAll(RAW_POSTGRES_TIMESTAMP),
    (match) => match[1],
  ).filter((column): column is string => column !== undefined)
  assertExactTimestampColumns(rawTimestampColumns, '変換前')

  if (occurrences(generated, 'uniqueIndex(') !== 0) {
    throw new Error(
      'Better Auth生成結果に想定外のuniqueIndexがあります。複合一意indexの生成規則を確認してください。',
    )
  }

  const withImport = replaceExactlyOnce(
    generated,
    PG_CORE_IMPORT,
    PG_CORE_IMPORT_WITH_UNIQUE,
    'pg-core import anchor',
  )
  const withUniqueIndex = replaceExactlyOnce(
    withImport,
    ACCOUNT_INDEX_ANCHOR,
    ACCOUNT_INDEXES_WITH_UNIQUE,
    'account index anchor',
  )

  const transformed = withUniqueIndex.replace(
    RAW_POSTGRES_TIMESTAMP,
    (_match, columnName: string) => {
      return `timestamp("${columnName}", { withTimezone: true })`
    },
  )

  const transformedTimestampColumns = Array.from(
    transformed.matchAll(TIMESTAMPTZ),
    (match) => match[1],
  ).filter((column): column is string => column !== undefined)
  assertExactTimestampColumns(transformedTimestampColumns, '変換後')

  if (
    occurrences(transformed, PG_CORE_IMPORT_WITH_UNIQUE) !== 1 ||
    occurrences(transformed, 'uniqueIndex(') !== 1 ||
    occurrences(
      transformed,
      'uniqueIndex("account_providerId_accountId_uidx")',
    ) !== 1
  ) {
    throw new Error(
      'Better Auth生成結果へのaccount複合unique index挿入が一意に完了しませんでした。生成器の変更を確認してください。',
    )
  }

  return `${GENERATED_HEADER}${transformed}`
}
