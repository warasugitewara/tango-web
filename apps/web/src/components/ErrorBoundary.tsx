import { Component, type ErrorInfo, type ReactNode } from 'react'

type State = { failed: boolean }

/**
 * 描画中の想定外の例外で、画面全体が白くなるのを防ぐ。
 * 詳細は利用者に見せず、再読み込みと最初の画面への戻り道だけを出す。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children
    }
    return (
      <main className="shell" role="alert">
        <h1>画面を表示できませんでした</h1>
        <p>時間をおいて、ページを読み込み直してください。</p>
        <p className="inline-links">
          <button type="button" onClick={() => window.location.reload()}>
            読み込み直す
          </button>
          <a href="/">単語帳へ戻る</a>
        </p>
      </main>
    )
  }
}
