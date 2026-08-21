import { describe, expect, test } from 'vitest'
import {
  createFsrsScheduler,
  DEFAULT_REQUEST_RETENTION,
  SCHEDULER_VERSION,
} from './fsrs-adapter'

const NOW = new Date('2026-08-21T00:00:00Z')

function scheduler() {
  return createFsrsScheduler(DEFAULT_REQUEST_RETENTION)
}

describe('createFsrsScheduler', () => {
  test('新規カードの初期状態を返す', () => {
    const initial = scheduler().initial(NOW)

    expect(initial.state).toBe('new')
    expect(initial.reps).toBe(0)
    expect(initial.lapses).toBe(0)
    expect(initial.lastReviewAt).toBeNull()
    expect(initial.dueAt.getTime()).toBe(NOW.getTime())
  })

  test('4段階すべてのプレビューを返す', () => {
    const preview = scheduler().preview(scheduler().initial(NOW), NOW)

    expect(Object.keys(preview).sort()).toEqual(['1', '2', '3', '4'])
  })

  test('評価が高いほど次回が遅くなる', () => {
    const preview = scheduler().preview(scheduler().initial(NOW), NOW)

    expect(preview[1].dueAt.getTime()).toBeLessThan(preview[2].dueAt.getTime())
    expect(preview[2].dueAt.getTime()).toBeLessThan(preview[3].dueAt.getTime())
    expect(preview[3].dueAt.getTime()).toBeLessThan(preview[4].dueAt.getTime())
  })

  test('新規カードの状態遷移を固定する', () => {
    // ライブラリ更新で挙動が変わったら気付けるようにするための固定値。
    // 値そのものの正しさを主張するテストではない。
    const preview = scheduler().preview(scheduler().initial(NOW), NOW)

    expect(preview[1].state).toBe('learning')
    expect(preview[2].state).toBe('learning')
    expect(preview[3].state).toBe('learning')
    expect(preview[4].state).toBe('review')
  })

  test('どの評価でも復習回数が1増える', () => {
    const preview = scheduler().preview(scheduler().initial(NOW), NOW)

    for (const rating of [1, 2, 3, 4] as const) {
      expect(preview[rating].reps).toBe(1)
      expect(preview[rating].lastReviewAt?.getTime()).toBe(NOW.getTime())
    }
  })

  test('復習中のカードを忘れると再学習へ落ちて失敗回数が増える', () => {
    const first = scheduler().preview(scheduler().initial(NOW), NOW)[4]
    const later = new Date(first.dueAt.getTime())
    const second = scheduler().preview(first, later)

    expect(first.state).toBe('review')
    expect(second[1].state).toBe('relearning')
    expect(second[1].lapses).toBe(first.lapses + 1)
    expect(second[3].state).toBe('review')
    expect(second[3].lapses).toBe(first.lapses)
  })

  test('希望保持率を上げると次回が早くなる', () => {
    // 保持率を上げるほど、忘れる前に復習させる必要がある。
    const relaxed = createFsrsScheduler(0.8)
    const strict = createFsrsScheduler(0.95)
    const at = (retention: ReturnType<typeof createFsrsScheduler>) =>
      retention.preview(retention.initial(NOW), NOW)[4].dueAt.getTime()

    expect(at(strict)).toBeLessThan(at(relaxed))
  })

  test('スケジューラ版と既定の希望保持率を固定する', () => {
    expect(SCHEDULER_VERSION).toBe('ts-fsrs@5.4.1/fsrs-6')
    expect(DEFAULT_REQUEST_RETENTION).toBe(0.9)
  })

  test('保持率は状態に記録され、契約の範囲に収まる', () => {
    const initial = scheduler().initial(NOW)

    expect(initial.requestRetention).toBe(DEFAULT_REQUEST_RETENTION)
    expect(initial.schedulerVersion).toBe(SCHEDULER_VERSION)
  })
})
