import type {
  FormalSession,
  FormalSessionReader,
  SocialProvider,
} from './actor-resolver'

/** 本文で扱う対応プロバイダ。Better Authが返す未知のproviderIdは無視する。 */
const SUPPORTED_PROVIDERS: readonly SocialProvider[] = ['google', 'github']

function isSupportedProvider(providerId: string): providerId is SocialProvider {
  return SUPPORTED_PROVIDERS.some((provider) => provider === providerId)
}

/** Better Authインスタンスのうち、ここで必要な部分だけを要求する。 */
export type FormalSessionSource = {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string; name: string; image?: string | null | undefined }
    } | null>
    listUserAccounts(input: {
      headers: Headers
    }): Promise<Array<{ providerId: string }>>
  }
}

/**
 * Better Authのセッションを読み取り、連携済みプロバイダを添えて返す。
 * Cookieの検証はBetter Auth側に委ね、ここでは値に触れない。
 */
export function createFormalSessionReader(
  auth: FormalSessionSource,
): FormalSessionReader {
  return {
    async read(request) {
      const session = await auth.api.getSession({ headers: request.headers })

      if (session === null) {
        return null
      }

      const accounts = await auth.api.listUserAccounts({
        headers: request.headers,
      })

      const providers = accounts
        .map((account) => account.providerId)
        .filter(isSupportedProvider)

      const formal: FormalSession = {
        userId: session.user.id,
        name: session.user.name,
        image: session.user.image ?? null,
        providers: [...new Set(providers)],
      }

      return formal
    },
  }
}
