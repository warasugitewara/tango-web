import type { Temporal } from '@js-temporal/polyfill'
import type { IdentityCompletionOutcome, PrincipalRepository } from '@tango/db'
import type { Actor } from '@tango/shared'
import type { GuestTokenCodec } from './guest-service'

export type FormalActor = Extract<Actor, { kind: 'user' }>

export type IdentityCompletionInput = {
  userId: string
  /** ゲストCookieの生値。存在しない場合は null。 */
  guestRawToken: string | null
  mergeKey: string
  now: Temporal.Instant
}

export type IdentityCompletion = {
  actor: FormalActor
  outcome: IdentityCompletionOutcome
}

export interface IdentityCompletionService {
  complete(input: IdentityCompletionInput): Promise<IdentityCompletion>
}

export type IdentityCompletionDependencies = {
  repository: PrincipalRepository
  tokenCodec: GuestTokenCodec
}

/**
 * principalを作る唯一の入口。
 * 生のゲストトークンはここでハッシュ化され、リポジトリより下へは渡らない。
 * mergeKeyによる冪等性はリポジトリのトランザクションが保証する。
 */
export function createIdentityCompletionService(
  dependencies: IdentityCompletionDependencies,
): IdentityCompletionService {
  const { repository, tokenCodec } = dependencies

  return {
    async complete({ userId, guestRawToken, mergeKey, now }) {
      const guestTokenHash =
        guestRawToken === null ? null : tokenCodec.hash(guestRawToken)

      const { principal, outcome } = await repository.completeIdentity({
        userId,
        guestTokenHash,
        mergeKey,
        now: new Date(now.epochMilliseconds),
      })

      return {
        actor: { kind: 'user', principalId: principal.id, userId },
        outcome,
      }
    },
  }
}
