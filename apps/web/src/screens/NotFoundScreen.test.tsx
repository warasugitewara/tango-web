import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test } from 'vitest'
import { NotFoundScreen } from './NotFoundScreen'

afterEach(cleanup)

test('見つからないことと戻り道を出す', () => {
  render(
    <MemoryRouter>
      <NotFoundScreen />
    </MemoryRouter>,
  )

  expect(
    screen.getByRole('heading', { name: 'ページが見つかりません' }),
  ).toBeTruthy()
  expect(
    screen.getByRole('link', { name: '単語帳へ戻る' }).getAttribute('href'),
  ).toBe('/')
})
