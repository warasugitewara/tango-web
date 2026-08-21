import { describe, expect, test } from 'vitest'
import { parseImportPayload } from './import-parser'

describe('parseImportPayload', () => {
  test('tango.content v1のJSONを解析する', () => {
    const payload = JSON.stringify({
      schema: 'tango.content',
      version: 1,
      cards: [{ front: '表1', back: '裏1' }],
    })

    expect(parseImportPayload({ format: 'json', payload })).toEqual([
      { front: '表1', back: '裏1' },
    ])
  })

  test('front,backのCSVを引用符とBOM込みで解析する', () => {
    const payload = '\ufefffront,back\r\n"表, 1","裏""1"\r\n表2,裏2\r\n'

    expect(parseImportPayload({ format: 'csv', payload })).toEqual([
      { front: '表, 1', back: '裏"1' },
      { front: '表2', back: '裏2' },
    ])
  })

  test('1件でも不正なら全体を拒否する', () => {
    const payload = JSON.stringify({
      schema: 'tango.content',
      version: 1,
      cards: [
        { front: '表1', back: '裏1' },
        { front: '', back: '裏2' },
      ],
    })

    expect(() => parseImportPayload({ format: 'json', payload })).toThrow()
  })

  test('壊れたJSONでも投入内容をエラーに載せない', () => {
    const marker = 'DUMMY-IMPORT-SECRET-MARKER'

    try {
      parseImportPayload({
        format: 'json',
        payload: `{"secret":"${marker}"`,
      })
      expect.unreachable('例外が発生するはず。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(marker)
    }
  })

  test('別versionと余分なCSV列を拒否する', () => {
    expect(() =>
      parseImportPayload({
        format: 'json',
        payload: JSON.stringify({
          schema: 'tango.content',
          version: 2,
          cards: [],
        }),
      }),
    ).toThrow()
    expect(() =>
      parseImportPayload({
        format: 'csv',
        payload: 'front,back,secret\n表,裏,値\n',
      }),
    ).toThrow()
  })
})
