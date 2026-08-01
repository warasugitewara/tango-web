import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import type { Database } from '@tango/db'
import { type BetterAuthOptions, betterAuth } from 'better-auth'

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

export type BetterAuthInput = {
  db: Database
  /** 検証済みの単一オリジン。ここ以外は信頼しない。 */
  appOrigin: string
  secret: string
  google: SocialCredentials
  github: SocialCredentials
  useSecureCookies: boolean
}

/**
 * Better Authの設定を組み立てる。
 * 匿名/ゲスト系のベータプラグインは読み込まず、ゲストは自前のprincipalで扱う。
 * OAuthトークンの暗号化はBetter Auth側のsecretに委ね、独自の暗号化層は重ねない。
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
    session: {
      expiresIn: FORMAL_SESSION_EXPIRES_IN_SECONDS,
      updateAge: FORMAL_SESSION_UPDATE_AGE_SECONDS,
      freshAge: FORMAL_SESSION_FRESH_AGE_SECONDS,
    },
    // アカウント削除はPhase 4で確認フローを備えるまで無効のままにする。
    user: { deleteUser: { enabled: false } },
    // 外部への利用状況送信は行わない。
    telemetry: { enabled: false },
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
