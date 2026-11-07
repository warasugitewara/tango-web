import { expect, test } from 'vitest'
import { toSafeFileName } from './download'

test('ファイル名に使えない記号を置き換える', () => {
  expect(toSafeFileName('英単語/中級: 2026?')).toBe('英単語_中級_ 2026_')
})

test('空になったら代わりの名前を使う', () => {
  expect(toSafeFileName('   ')).toBe('deck')
})
