import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, test } from 'vitest'
import { createMergeIntentCodec } from './merge-intent'

const SECRET = 'merge-intent-test-secret'
const NOW = Temporal.Instant.from('2026-09-26T03:00:00Z')

describe('createMergeIntentCodec', () => {
  const codec = createMergeIntentCodec(SECRET)

  test('署名した内容をそのまま取り出せる', () => {
    const token = codec.sign(
      { userId: 'user-a', mergeKey: '019fd000-0000-7000-8000-000000000001' },
      NOW,
    )

    expect(codec.verify(token, NOW)).toEqual({
      userId: 'user-a',
      mergeKey: '019fd000-0000-7000-8000-000000000001',
    })
  })

  test('期限を過ぎた証明は受け付けない', () => {
    // 統合の途中で放置された証明を、後から拾って使わせない。
    const token = codec.sign(
      { userId: 'user-a', mergeKey: '019fd000-0000-7000-8000-000000000001' },
      NOW,
    )

    expect(codec.verify(token, NOW.add({ hours: 1 }))).toBeNull()
  })

  test('改竄された証明を受け付けない', () => {
    const token = codec.sign(
      { userId: 'user-a', mergeKey: '019fd000-0000-7000-8000-000000000001' },
      NOW,
    )
    const [payload, signature] = token.split('.')
    const forged = `${Buffer.from(
      JSON.stringify({
        userId: 'user-b',
        mergeKey: '019fd000-0000-7000-8000-000000000001',
        expiresAt: NOW.add({ minutes: 5 }).epochMilliseconds,
      }),
    ).toString('base64url')}.${signature}`

    expect(payload).not.toBe('')
    expect(codec.verify(forged, NOW)).toBeNull()
  })

  test('別の鍵で署名された証明を受け付けない', () => {
    const other = createMergeIntentCodec('another-secret')
    const token = other.sign(
      { userId: 'user-a', mergeKey: '019fd000-0000-7000-8000-000000000001' },
      NOW,
    )

    expect(codec.verify(token, NOW)).toBeNull()
  })

  test('形式が壊れた証明を受け付けない', () => {
    expect(codec.verify('', NOW)).toBeNull()
    expect(codec.verify('not-a-token', NOW)).toBeNull()
    expect(codec.verify('a.b.c', NOW)).toBeNull()
  })

  test('鍵が空なら作らせない', () => {
    expect(() => createMergeIntentCodec('')).toThrow()
  })
})
