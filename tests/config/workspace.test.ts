import { describe, expect, test } from 'vitest'
import rootPackage from '../../package.json'

describe('workspace contract', () => {
  test('locks the four workspace packages and required scripts', () => {
    expect(rootPackage.workspaces).toEqual(['apps/*', 'packages/*'])
    expect(Object.keys(rootPackage.scripts)).toEqual(
      expect.arrayContaining(['check', 'typecheck', 'test', 'build']),
    )
  })
})
