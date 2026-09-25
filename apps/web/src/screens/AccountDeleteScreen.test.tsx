import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AccountDeleteScreen } from './AccountDeleteScreen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen() {
  const deleted: unknown[] = []

  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(
        typeof input === 'string' ? input : input.toString(),
        'https://tango.test',
      ).pathname

      if (path === '/api/security/csrf') {
        return new Response(JSON.stringify({ csrfToken: 'test-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (path === '/api/account/delete') {
        deleted.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
        )
        return new Response(null, { status: 204 })
      }

      return new Response(
        JSON.stringify({ decks: 11, cards: 373, reviews: 38 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  )

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AccountDeleteScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  )

  return { deleted }
}

describe('AccountDeleteScreen', () => {
  test('消える対象を件数で示す', async () => {
    renderScreen()

    expect(await screen.findByText('11')).toBeTruthy()
    expect(screen.getByText('373')).toBeTruthy()
    expect(screen.getByText('38')).toBeTruthy()
  })

  test('取り消せないことを伝える', async () => {
    renderScreen()

    expect(await screen.findByText(/取り消せません/)).toBeTruthy()
  })

  test('消す前に書き出す導線を出す', async () => {
    // 消してから「あれが欲しかった」となる場面を減らす。
    renderScreen()

    expect(await screen.findByRole('link', { name: /書き出/ })).toBeTruthy()
  })

  test('文言が一致するまで実行できない', async () => {
    renderScreen()

    const button = await screen.findByRole('button', { name: '完全に削除する' })
    expect(button.hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText(/確認のため/), {
      target: { value: 'けす' },
    })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  test('文言が一致したら削除を送る', async () => {
    const { deleted } = renderScreen()

    fireEvent.change(await screen.findByLabelText(/確認のため/), {
      target: { value: '削除します' },
    })
    fireEvent.click(screen.getByRole('button', { name: '完全に削除する' }))

    expect(await screen.findByText(/削除しました/)).toBeTruthy()
    expect(deleted).toEqual([{ confirm: '削除します' }])
  })
})
