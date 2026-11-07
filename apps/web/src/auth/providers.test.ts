import { expect, test } from 'vitest'
import { providerLabel, providerLabels } from './providers'

test('既知のプロバイダは正式表記で、定義順に並べる', () => {
  expect(providerLabels(['github', 'google'])).toBe('Google、GitHub')
})

test('未知のプロバイダはIDのまま後ろへ置く', () => {
  expect(providerLabels(['other', 'google'], '・')).toBe('Google・other')
  expect(providerLabel('other')).toBe('other')
})
