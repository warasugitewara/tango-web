import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { forgetSignedInData, invalidateContent, queryKeys } from './query-keys'

test('ログアウト後はセッションを未ログインにし、ほかのキャッシュを捨てる', () => {
  const client = new QueryClient()
  client.setQueryData(queryKeys.session, { authenticated: true })
  client.setQueryData(queryKeys.decks, [{ id: 'old' }])
  client.setQueryData(queryKeys.dashboard, { completedToday: 3 })

  forgetSignedInData(client)

  expect(client.getQueryData(queryKeys.session)).toEqual({
    authenticated: false,
  })
  expect(client.getQueryData(queryKeys.decks)).toBeUndefined()
  expect(client.getQueryData(queryKeys.dashboard)).toBeUndefined()
})

test('中身が変わったらデッキ一覧・残数・進捗・ゴミ箱・そのデッキのカードを古くする', async () => {
  const client = new QueryClient()
  const keys = [
    queryKeys.decks,
    queryKeys.deckQueues,
    queryKeys.dashboard,
    queryKeys.trash,
    queryKeys.cardPage('deck-1', 50),
  ]
  for (const key of keys) {
    client.setQueryData(key, 'cached')
  }
  client.setQueryData(queryKeys.cardPage('deck-2', 0), 'cached')

  await invalidateContent(client, 'deck-1')

  for (const key of keys) {
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  }
  expect(
    client.getQueryState(queryKeys.cardPage('deck-2', 0))?.isInvalidated,
  ).toBe(false)
})
