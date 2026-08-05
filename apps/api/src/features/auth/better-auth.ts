import { randomUUID } from 'node:crypto'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import type { Database } from '@tango/db'
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { OAUTH_ERROR_PATH } from './oauth-error-page'

/** 正式セッションの有効期間。アクセスのたびにローリング更新する。 */
export const FORMAL_SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30

/** セッション行を更新する最短間隔。書き込み回数を抑える。 */
export const FORMAL_SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24

/** 連携解除など重要操作で再ログインを求める鮮度。 */
export const FORMAL_SESSION_FRESH_AGE_SECONDS = 600

export type SocialCredentials = {
  clientId: string
  clientSecret: string
}

export type BetterAuthLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type BetterAuthLogEntry = Readonly<{
  component: 'better-auth'
  level: BetterAuthLogLevel
  errorId: string
}>

export type BetterAuthLogSink = (entry: BetterAuthLogEntry) => void

function writeBetterAuthLogToConsole(entry: BetterAuthLogEntry): void {
  const serialized = JSON.stringify(entry)

  if (entry.level === 'error') {
    console.error(serialized)
    return
  }
  if (entry.level === 'warn') {
    console.warn(serialized)
    return
  }
  console.info(serialized)
}

function createSafeBetterAuthLogger(sink: BetterAuthLogSink) {
  return {
    level: 'warn',
    log(
      level: BetterAuthLogLevel,
      _message: string,
      ..._rawArguments: unknown[]
    ): void {
      try {
        sink({
          component: 'better-auth',
          level,
          errorId: randomUUID(),
        })
      } catch {
        // logger障害で認証処理をmaskせず、raw入力をfallback先へ再送しない。
      }
    },
  } as const
}

export type BetterAuthInput = {
  db: Database
  /** 検証済みの単一オリジン。ここ以外は信頼しない。 */
  appOrigin: string
  secret: string
  google: SocialCredentials
  github: SocialCredentials
  useSecureCookies: boolean
  /** Better Auth由来のraw message/argsを受け取らない構造化log境界。 */
  authLogSink?: BetterAuthLogSink
}

/**
 * Better Authの設定を組み立てる。
 * 匿名/ゲスト系のベータプラグインは読み込まず、ゲストは自前のprincipalで扱う。
 * access/refresh tokenの暗号化はBetter Auth側へ委ね、ID tokenは保存しない。
 */
export function createBetterAuthOptions(input: BetterAuthInput) {
  const cookieAttributes = {
    httpOnly: true,
    secure: input.useSecureCookies,
    sameSite: 'lax',
    path: '/',
  } as const

  return {
    baseURL: input.appOrigin,
    basePath: '/api/auth',
    secret: input.secret,
    database: drizzleAdapter(input.db, { provider: 'pg' }),
    trustedOrigins: [input.appOrigin],
    plugins: [],
    logger: createSafeBetterAuthLogger(
      input.authLogSink ?? writeBetterAuthLogToConsole,
    ),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: input.google.clientId,
        clientSecret: input.google.clientSecret,
      },
      github: {
        clientId: input.github.clientId,
        clientSecret: input.github.clientSecret,
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      accountLinking: {
        enabled: true,
        // 同じメールアドレスでも暗黙には結び付けない。明示的なlinkSocialだけを許す。
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
      },
    },
    databaseHooks: {
      account: {
        create: {
          async before(account) {
            return { data: { ...account, idToken: null } }
          },
        },
        update: {
          async before(account) {
            return { data: { ...account, idToken: null } }
          },
        },
      },
    },
    session: {
      expiresIn: FORMAL_SESSION_EXPIRES_IN_SECONDS,
      updateAge: FORMAL_SESSION_UPDATE_AGE_SECONDS,
      freshAge: FORMAL_SESSION_FRESH_AGE_SECONDS,
    },
    // アカウント削除はPhase 4で確認フローを備えるまで無効のままにする。
    user: { deleteUser: { enabled: false } },
    // 外部への利用状況送信は行わない。
    telemetry: { enabled: false },
    onAPIError: {
      // OAuth callbackのerror queryを、アプリ側の安定コードと日本語案内へ写像する。
      errorURL: new URL(OAUTH_ERROR_PATH, input.appOrigin).toString(),
    },
    advanced: {
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: input.useSecureCookies,
      defaultCookieAttributes: cookieAttributes,
    },
  } satisfies BetterAuthOptions
}

export function createAuth(input: BetterAuthInput) {
  return betterAuth(createBetterAuthOptions(input))
}

export type Auth = ReturnType<typeof createAuth>
