import { describe, expect, test } from 'vitest'
import { transformBetterAuthPostgresSchema } from './auth-schema'

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

function createPinnedRawSchema(): string {
  return `import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
`
}

function transformedTimestampColumns(schema: string): string[] {
  return Array.from(
    schema.matchAll(/timestamp\("([^"]+)", \{ withTimezone: true \}\)/g),
    (match) => match[1],
  ).filter((column): column is string => column !== undefined)
}

describe('transformBetterAuthPostgresSchema', () => {
  test('generates exactly twelve TIMESTAMPTZ columns and one provider identity unique index', () => {
    const transformed = transformBetterAuthPostgresSchema(
      createPinnedRawSchema(),
    )

    expect(transformedTimestampColumns(transformed).sort()).toEqual(
      EXPECTED_TIMESTAMP_COLUMNS,
    )
    expect(transformed).toContain(
      'pgTable, text, timestamp, boolean, index, uniqueIndex',
    )
    expect(transformed.match(/uniqueIndex\(/g)).toHaveLength(1)
    expect(transformed).toContain(
      'uniqueIndex("account_providerId_accountId_uidx").on(\n      table.providerId,\n      table.accountId,\n    )',
    )
  })

  test('fails closed when a pinned timestamp column is missing', () => {
    const missingTimestamp = createPinnedRawSchema().replace(
      '  updatedAt: timestamp("updated_at").defaultNow().notNull(),\n});\n',
      '});\n',
    )

    expect(() => transformBetterAuthPostgresSchema(missingTimestamp)).toThrow(
      /timestamp/i,
    )
  })

  test('fails closed when an unexpected timestamp column appears', () => {
    const unexpectedTimestamp = createPinnedRawSchema().replace(
      '  id: text("id").primaryKey(),\n  expiresAt:',
      '  id: text("id").primaryKey(),\n  consumedAt: timestamp("consumed_at"),\n  expiresAt:',
    )

    expect(() =>
      transformBetterAuthPostgresSchema(unexpectedTimestamp),
    ).toThrow(/timestamp/i)
  })

  test('fails closed when the pg-core import anchor changes', () => {
    const missingImportAnchor = createPinnedRawSchema().replace(
      'pgTable, text, timestamp, boolean, index',
      'boolean, index, pgTable, text, timestamp',
    )

    expect(() =>
      transformBetterAuthPostgresSchema(missingImportAnchor),
    ).toThrow(/import/i)
  })

  test('fails closed when the account index anchor changes', () => {
    const missingAccountAnchor = createPinnedRawSchema().replace(
      'index("account_userId_idx")',
      'index("account_user_id_idx")',
    )

    expect(() =>
      transformBetterAuthPostgresSchema(missingAccountAnchor),
    ).toThrow(/account/i)
  })

  test('fails closed instead of generating a second provider identity unique index', () => {
    const duplicateUnique = createPinnedRawSchema().replace(
      'index("account_userId_idx").on(table.userId)',
      'index("account_userId_idx").on(table.userId), uniqueIndex("existing_uidx").on(table.providerId, table.accountId)',
    )

    expect(() => transformBetterAuthPostgresSchema(duplicateUnique)).toThrow(
      /unique/i,
    )
  })
})
