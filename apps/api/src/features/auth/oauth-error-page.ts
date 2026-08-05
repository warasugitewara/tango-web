import { AppError } from '@tango/shared'
import { Hono } from 'hono'

/** Better Auth callbackの失敗を受け取る、同一originの固定パス。 */
export const OAUTH_ERROR_PATH = '/auth/error'

const BETTER_AUTH_ACCOUNT_NOT_LINKED = 'account_not_linked'

function renderPage(code: string, message: string): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ログインを完了できませんでした | Tango</title>
  </head>
  <body>
    <main>
      <h1>ログインを完了できませんでした</h1>
      <p>${message}</p>
      <p><code>${code}</code></p>
      <p><a href="/">Tangoに戻る</a></p>
    </main>
  </body>
</html>`
}

/**
 * Better Auth固有のOAuthエラーを、公開してよい安定コードと日本語案内へ写像する。
 * queryの生値はHTMLへ反映せず、未知のエラーも内部情報を露出しない。
 */
export function createOAuthErrorRoutes() {
  return new Hono().get(OAUTH_ERROR_PATH, (context) => {
    if (context.req.query('error') === BETTER_AUTH_ACCOUNT_NOT_LINKED) {
      const error = new AppError('ACCOUNT_NOT_LINKED')
      return context.html(renderPage(error.code, error.publicMessage), 409)
    }

    const error = new AppError('UNAUTHENTICATED', {
      publicMessage:
        'ログインを完了できませんでした。元の画面へ戻り、もう一度お試しください。',
    })
    return context.html(renderPage(error.code, error.publicMessage), 401)
  })
}
