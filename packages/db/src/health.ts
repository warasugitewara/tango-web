import { getTableName, is, sql, Table } from 'drizzle-orm'
import type { Database } from './client'
import * as schema from './schema'

/** スキーマ定義が必要とするテーブル名。移行の取りこぼしはこことの差で出る。 */
export function expectedTableNames(): readonly string[] {
  const names: string[] = []
  for (const value of Object.values(schema)) {
    if (is(value, Table)) {
      names.push(getTableName(value))
    }
  }

  return [...new Set(names)]
}

export function findMissingTables(
  expected: readonly string[],
  actual: readonly string[],
): readonly string[] {
  const present = new Set(actual)

  return expected.filter((name) => !present.has(name))
}

/**
 * 受け入れ可否。接続できること、コードが要るテーブルが揃っていることを見る。
 * 真偽しか返さない。理由には接続先や構造が混ざるため、呼び出し側へも渡さない。
 */
export async function checkDatabaseReady(db: Database): Promise<boolean> {
  try {
    const rows = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    )
    const actual = [...rows].flatMap((row) =>
      typeof row.table_name === 'string' ? [row.table_name] : [],
    )

    return findMissingTables(expectedTableNames(), actual).length === 0
  } catch {
    return false
  }
}
