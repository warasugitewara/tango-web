/**
 * `auth generate` (Better Auth CLI) 専用の設定。
 * 生成結果はオプションの構造だけで決まり、接続情報やシークレットの値には依存しない。
 * そのため環境変数を一切読まず、固定のダミー値だけで完結させる。
 * 実行時の設定は `better-auth.ts` の `createAuth` が唯一の入口。
 */

import { createDatabase } from '@tango/db'
import { createAuth, createBetterAuthOptions } from './better-auth'

/** 生成にしか使わないダミー値。実際のシークレットはここへ来ない。 */
const PLACEHOLDER = 'schema-generation-only'

// 生成中に接続は発生しない。Drizzleアダプタの結線だけを与える。
const database = createDatabase(
  `postgres://${PLACEHOLDER}@127.0.0.1:5432/unused`,
  { max: 1 },
)

const input = {
  db: database.db,
  appOrigin: 'https://tango.warasugi.com',
  secret: PLACEHOLDER.padEnd(32, '0'),
  google: { clientId: PLACEHOLDER, clientSecret: PLACEHOLDER },
  github: { clientId: PLACEHOLDER, clientSecret: PLACEHOLDER },
  useSecureCookies: true,
}

export const betterAuthOptions = createBetterAuthOptions(input)

export const auth = createAuth(input)
