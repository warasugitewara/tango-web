import { Link } from 'react-router'

/** 定義していないURL。白い画面のまま止めず、戻り道を出す。 */
export function NotFoundScreen() {
  return (
    <main className="shell">
      <title>ページが見つかりません | Tango</title>
      <h1>ページが見つかりません</h1>
      <p>URLが間違っているか、ページが移動した可能性があります。</p>
      <Link className="study-link" to="/">
        単語帳へ戻る
      </Link>
    </main>
  )
}
