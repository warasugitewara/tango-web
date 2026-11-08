import type { QueryClient } from '@tanstack/react-query'
import type { SessionView } from './client'

/**
 * 画面が共有するキャッシュの鍵。
 * 文字列を各画面へ散らすと、更新後に捨てるべき鍵の取りこぼしが起きる。
 * 鍵はここだけで定め、捨て方も下の関数へまとめる。
 */
export const queryKeys = {
  session: ['session'],
  decks: ['decks'],
  deckQueues: ['deck-queues'],
  dashboard: ['dashboard'],
  trash: ['trash'],
  /** 先頭2要素で前方一致させると、そのデッキの全ページをまとめて捨てられる。 */
  cards: (deckId: string) => ['cards', deckId] as const,
  cardPage: (deckId: string, offset: number) =>
    ['cards', deckId, offset] as const,
  studySession: (deckId: string | null) =>
    ['study-session', deckId ?? 'all'] as const,
  mergePreview: ['merge-preview'],
  accountSummary: ['account-summary'],
} as const

/**
 * 学習の進み具合に関わる集計を捨てる。
 * 評価・取り消しのほか、カードの増減でも当日の残数は変わる。
 */
export async function invalidateStudyProgress(
  queryClient: QueryClient,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.deckQueues }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
  ])
}

/**
 * カードやデッキの中身が変わったときに捨てるもの。
 * デッキ一覧の枚数・当日の残数・進捗・ゴミ箱は、どれも中身から導かれる。
 */
export async function invalidateContent(
  queryClient: QueryClient,
  deckId?: string,
): Promise<void> {
  await Promise.all([
    deckId === undefined
      ? Promise.resolve()
      : queryClient.invalidateQueries({ queryKey: queryKeys.cards(deckId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.decks }),
    queryClient.invalidateQueries({ queryKey: queryKeys.trash }),
    invalidateStudyProgress(queryClient),
  ])
}

/**
 * ログアウトや退会のあと、前の利用者のデータを画面に残さない。
 *
 * 先にセッションを「未ログイン」で確定させる。そうすると各画面の取得は
 * `enabled` が偽になり、消した直後に前の利用者の資格で取り直しに行かない。
 * そのうえでセッション以外のキャッシュを捨てる。`invalidateQueries` だけでは
 * 古いデータが表示され続け、同じタブで別の人が始めると一瞬見えてしまう。
 */
export function forgetSignedInData(queryClient: QueryClient): void {
  const signedOut: SessionView = { authenticated: false }
  queryClient.setQueryData(queryKeys.session, signedOut)
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== queryKeys.session[0],
  })
}
