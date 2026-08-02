import type { Temporal } from '@js-temporal/polyfill'
import type { PrincipalRepository } from '@tango/db'
import { type Actor, formatJst } from '@tango/shared'

export type SocialProvider = 'google' | 'github'

/**
 * Better Authが管理する正式セッションの読み取り結果。
 * 実装 (`formal-session-reader.ts`) はTask 5で追加する。
 */
export type FormalSession = {
  userId: string
  name: string
  image: string | null
  providers: SocialProvider[]
}

export interface FormalSessionReader {
  read(request: Request): Promise<FormalSession | null>
}

export type FormalUserActor = Extract<Actor, { kind: 'user' }>

export type FormalResolution = {
  session: FormalSession
  /** principal未作成の正式ユーザーは null。identity completion だけが作成できる。 */
  actor: FormalUserActor | null
}

export interface ActorResolver {
  resolveFormal(request: Request): Promise<FormalResolution | null>
}

export type ActorResolverDependencies = {
  repository: PrincipalRepository
  formalSessionReader: FormalSessionReader
}

export function createActorResolver(
  dependencies: ActorResolverDependencies,
): ActorResolver {
  const { repository, formalSessionReader } = dependencies

  return {
    async resolveFormal(request) {
      const session = await formalSessionReader.read(request)

      if (session === null) {
        return null
      }

      const principal = await repository.findByUserId(session.userId)

      if (principal === null) {
        return { session, actor: null }
      }

      return {
        session,
        actor: {
          kind: 'user',
          principalId: principal.id,
          userId: session.userId,
        },
      }
    },
  }
}

/** セッション表示のための共通ビュー。 */
export type SessionView =
  | { authenticated: false }
  | {
      authenticated: true
      kind: 'guest'
      expiresAt: string
      warning: string
    }
  | {
      authenticated: true
      kind: 'user'
      user: { id: string; name: string; image: string | null }
      providers: SocialProvider[]
    }

export function toGuestSessionView(
  expiresAt: Temporal.Instant,
  warning: string,
): SessionView {
  return {
    authenticated: true,
    kind: 'guest',
    // 画面はJST前提で日時を扱うため、境界では必ず +09:00 を明示する。
    expiresAt: formatJst(expiresAt),
    warning,
  }
}

export function toUserSessionView(session: FormalSession): SessionView {
  return {
    authenticated: true,
    kind: 'user',
    user: { id: session.userId, name: session.name, image: session.image },
    providers: session.providers,
  }
}
