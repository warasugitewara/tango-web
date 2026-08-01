import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { createDatabase } from '@tango/db'
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { loadEnv } from '../../env'

const env = loadEnv(process.env)

// スキーマ生成とマイグレーション整合性の確認にしか使わないので接続は最小にする。
const database = createDatabase(env.DATABASE_URL, { max: 1 })

/**
 * Better Authのオプション。
 * 認証プロバイダやセッション設定はTask 5で追加する。
 * ここではDrizzleアダプタの結線のみを確定させ、スキーマ生成の入力とする。
 */
export const betterAuthOptions = {
  baseURL: env.APP_ORIGIN,
  basePath: '/api/auth',
  database: drizzleAdapter(database.db, { provider: 'pg' }),
  emailAndPassword: { enabled: false },
} satisfies BetterAuthOptions

export const auth = betterAuth(betterAuthOptions)
