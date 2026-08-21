import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { CardMarkdown } from './CardMarkdown'

afterEach(cleanup)

test('生HTMLをそのまま描画しない', () => {
  const { container } = render(
    <CardMarkdown text={'<img src=x onerror=alert(1)> **太字**'} />,
  )

  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('strong')?.textContent).toBe('太字')
})
