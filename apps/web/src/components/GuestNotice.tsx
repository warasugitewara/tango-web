import { SignInButtons } from './SignInButtons'

/** ゲストのデータが失われうる理由と、その対処を並べて示す。 */
export function GuestNotice(props: { warning: string }) {
  return (
    <aside className="guest-warning">
      <p>{props.warning}</p>
      <p>ログインすると、別のブラウザや端末へ学習データを引き継げます。</p>
      <SignInButtons />
    </aside>
  )
}
