import { readFile } from 'node:fs/promises'
import { z } from 'zod'

/**
 * 本番で唯一許可する公開オリジン。
 * ここを固定することでCookieのSecure属性がhttpへ落ちる経路をなくす。
 */
export const PRODUCTION_APP_ORIGIN = 'https://tango.warasugi.com'

/** 接続先として受け入れるプロトコル。PostgreSQL以外へは決して接続させない。 */
const POSTGRES_PROTOCOLS: ReadonlySet<string> = new Set([
  'postgres:',
  'postgresql:',
])

const optionalNonEmptyString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
)

/**
 * PostgreSQLの接続URLとして解釈できるかどうかだけを判定する。
 * 判定結果には値を一切含めない。呼び出し側もキー名しか報告しない。
 *
 * `postgres:` はspecial schemeではないため `new URL('postgres:whatever')` も
 * 成功してしまう。接続先を取り違えたまま起動しないよう、
 * ホストとデータベース名が実際に入っていることまで確かめる。
 */
function isPostgresConnectionUrl(value: string): boolean {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return false
  }

  return (
    POSTGRES_PROTOCOLS.has(url.protocol) &&
    url.hostname !== '' &&
    url.pathname.replace(/^\//, '') !== ''
  )
}

const environmentShape = {
  APP_ENV: z.enum(['development', 'test', 'production']),
  APP_ORIGIN: z.url(),
  /**
   * PostgreSQLの接続URL。解釈できない値やプロトコル違いは起動前に落とす。
   * エラーメッセージには値を載せない（パスワードが含まれるため）。
   */
  DATABASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .min(1)
      .refine(isPostgresConnectionUrl, {
        message: 'postgres: または postgresql: のURLを指定してください。',
      })
      .optional(),
  ),
  /** 本番では接続URLを環境変数へ展開せず、Docker secretから読む。 */
  DATABASE_URL_FILE: optionalNonEmptyString,
  /** ゲストトークンのHMACペッパーを格納したファイルのパス。値自体は環境変数に置かない。 */
  GUEST_TOKEN_PEPPER_FILE: z.string().min(1),
  TURNSTILE_SITE_KEY: z.string().min(1),
  /** Cloudflare Turnstileのシークレットを格納したファイルのパス。 */
  TURNSTILE_SECRET_FILE: z.string().min(1),
  /** Better Authの署名・暗号化に使うシークレットを格納したファイルのパス。 */
  BETTER_AUTH_SECRET_FILE: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  /** GoogleのOAuthクライアントシークレットを格納したファイルのパス。 */
  GOOGLE_CLIENT_SECRET_FILE: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  /** GitHubのOAuthクライアントシークレットを格納したファイルのパス。 */
  GITHUB_CLIENT_SECRET_FILE: z.string().min(1),
}

/** `.env.example` と同期すべき、アプリ固有の環境変数キー。 */
export const ENVIRONMENT_KEYS = Object.freeze(
  Object.keys(environmentShape).sort(),
)

const environmentSchema = z
  .object(environmentShape)
  .superRefine((value, ctx) => {
    if (
      (value.DATABASE_URL === undefined) ===
      (value.DATABASE_URL_FILE === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'DATABASE_URLかDATABASE_URL_FILEのどちらか一方が必要です。',
      })
    }

    // 本番のオリジンを取り違えると、Secure Cookieが外れたまま起動してしまう。
    // 設定ミスは起動前に落とす。
    if (
      value.APP_ENV === 'production' &&
      value.APP_ORIGIN !== PRODUCTION_APP_ORIGIN
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ORIGIN'],
        message: `productionでは ${PRODUCTION_APP_ORIGIN} 以外を指定できません。`,
      })
    }
  })

export type Env = Readonly<z.infer<typeof environmentSchema>>

/**
 * 環境変数を検証して読み取り専用のEnvを返す。
 * 検証に失敗した場合はキー名だけを含むエラーを投げ、値は決して露出させない。
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = environmentSchema.safeParse(source)

  if (!result.success) {
    const invalidKeys = [
      ...new Set(
        result.error.issues.map((issue) => String(issue.path[0] ?? '(root)')),
      ),
    ].sort()

    throw new Error(
      `環境変数の検証に失敗しました。次のキーを確認してください: ${invalidKeys.join(', ')}`,
    )
  }

  return Object.freeze(result.data)
}

/**
 * CookieへSecure属性を付けるかどうかを決める。
 * `loadEnv` がproductionのAPP_ORIGINをhttpsの固定値に縛るため、
 * production起動時にこの関数がfalseを返すことはない。
 * ローカルのhttp検証でだけfalseになる。
 */
export function isSecureCookieOrigin(env: Env): boolean {
  return new URL(env.APP_ORIGIN).protocol === 'https:'
}

/**
 * シークレットをファイルから読み取る。
 * 読み取りに失敗してもパスだけを報告し、内容は決してログへ出さない。
 */
export async function readSecretFile(path: string): Promise<string> {
  let contents: string

  try {
    contents = await readFile(path, 'utf8')
  } catch {
    throw new Error(`シークレットファイルを読み取れませんでした: ${path}`)
  }

  const secret = contents.trim()

  if (secret === '') {
    throw new Error(`シークレットファイルが空です: ${path}`)
  }

  return secret
}

/** PostgreSQL接続URLを直接値またはsecret fileのどちらか一方から得る。 */
export async function resolveDatabaseUrl(env: Env): Promise<string> {
  if (env.DATABASE_URL !== undefined) {
    return env.DATABASE_URL
  }

  const path = env.DATABASE_URL_FILE
  if (path === undefined) {
    throw new Error('DATABASE_URL_FILEを確認してください。')
  }
  const value = await readSecretFile(path)
  if (!isPostgresConnectionUrl(value)) {
    throw new Error('DATABASE_URL_FILEの内容を確認してください。')
  }
  return value
}
