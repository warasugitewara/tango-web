import type { StudyDashboard } from '../api/client'
import { toDateTimeLabel } from '../lib/format'

function totalRemaining(remaining: StudyDashboard['remaining']): number {
  return remaining.review + remaining.learning + remaining.new
}

/** 活動量の濃さ。枚数そのものは読み上げ用のラベルで伝える。 */
function activityLevel(reviews: number): number {
  if (reviews === 0) {
    return 0
  }
  if (reviews < 5) {
    return 1
  }
  return reviews < 10 ? 2 : 3
}

export function ProgressPanel(props: { progress: StudyDashboard }) {
  const { progress } = props

  return (
    <section className="progress-panel" aria-label="学習の進み具合">
      <p className="progress-figures">
        <span>今日 {progress.completedToday}枚</span>
        <span>連続 {progress.streakDays}日</span>
        <span>残り {totalRemaining(progress.remaining)}枚</span>
      </p>
      <ul className="activity-row">
        {progress.activity.map((day) => (
          <li
            key={day.learningDay}
            className="activity-cell"
            aria-label={`${day.learningDay} ${day.reviews}枚`}
            data-level={activityLevel(day.reviews)}
          />
        ))}
      </ul>
      <p className="activity-note">
        {progress.nextDueAt === null
          ? '次の予定はありません。'
          : `次回 ${toDateTimeLabel(progress.nextDueAt)}`}
      </p>
    </section>
  )
}
