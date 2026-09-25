import { zValidator } from '@hono/zod-validator'
import type { PrincipalRepository } from '@tango/db'
import { AppError, accountDeleteSchema } from '@tango/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../middleware/request-context'

export type AccountRoutesOptions = {
  repository: Pick<
    PrincipalRepository,
    'summarizeMergeCandidate' | 'deleteUser'
  >
}

/**
 * 自分のアカウントを閉じる経路。
 *
 * 所有データは外部キーのcascadeで一緒に消える。監査ログだけは actor を
 * NULL にして残るため、追跡は保ちつつ本人への紐付けは残らない。
 */
export function createAccountRoutes(options: AccountRoutesOptions) {
  const { repository } = options

  return new Hono<AppEnv>()
    .get('/account/summary', async (context) => {
      const formalSession = context.get('formalSession')
      if (formalSession === null) {
        throw new AppError('UNAUTHENTICATED')
      }

      const summary = await repository.summarizeMergeCandidate(
        formalSession.userId,
      )
      if (summary === null) {
        throw new AppError('NOT_FOUND')
      }

      return context.json({
        decks: summary.decks,
        cards: summary.cards,
        reviews: summary.reviews,
      })
    })
    .post(
      '/account/delete',
      // 文言は画面だけでなくサーバでも確かめる。
      zValidator('json', accountDeleteSchema, (result) => {
        if (!result.success) {
          throw new AppError('VALIDATION_FAILED', {
            publicMessage: '確認の文言が一致しません。',
            fieldErrors: z.flattenError(result.error).fieldErrors,
          })
        }
      }),
      async (context) => {
        const formalSession = context.get('formalSession')
        if (formalSession === null) {
          throw new AppError('UNAUTHENTICATED')
        }

        await repository.deleteUser(formalSession.userId)

        // セッション行も一緒に消えるため、以降の要求は未認証になる。
        return context.body(null, 204)
      },
    )
}
