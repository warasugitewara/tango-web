# Phase 1 レビューパケット: 基盤と識別

- 対象ブランチ: `feat/phase-1-foundation-identity`
- 対象範囲: `main` (`314264f`) からブランチ HEAD まで
- 計画: `docs/superpowers/plans/2026-08-01-tango-01-foundation-identity.md`
- 仕様: `docs/superpowers/specs/2026-08-01-tango-spaced-repetition-design.md`
- 未 push。Phase 2 の実装には未着手。

レビュー観点 (計画 Task 6 Step 7): 仕様適合、識別処理の競合、Cookie とトークンの取り扱い、Better Auth 設定、マイグレーション、テスト証跡。

## 1. コミットマップ

| Task | コミット | メッセージ | 主な変更 |
| --- | --- | --- | --- |
| — | `e2837d3` | docs: Tango設計と段階別実装計画を追加 | 仕様と 4 フェーズ計画のベースライン |
| 1 | `36efcda` | chore: Bunワークスペースと品質ゲートを初期化 | Bun ワークスペース、Biome、Vitest、TS strict、CI、`.env.example` |
| 2 | `080e522` | feat: JST学習日と共通エラー契約を追加 | `learningDayOf` (04:00 JST 境界)、`AppError`、`Actor` / `ServiceContext` |
| 3 | `9762d83` | feat: 認証主体とゲストセッションのDB基盤を追加 | Drizzle スキーマ、`0000_identity` マイグレーション、`PrincipalRepository`、テスト用 PostgreSQL、生成スキーマのドリフト検査 |
| 4 | `ca593cf` | feat: 安全なゲスト認証と期限管理を追加 | `GuestService`、Turnstile 検証、`requestContext`、`onError`、`/api/guest/start`、`/api/session`、期限切れゲスト削除ジョブ |
| 5 | `28d4831` | feat: GoogleとGitHubの正式アカウント連携を追加 | Better Auth 設定と `/api/auth/*` 委譲、`IdentityCompletionService`、`/api/identity/complete`、シークレットのファイル読み込み |
| 6 | (本コミット) | test: 認証基盤の統合検証とレビュー資料を追加 | 通し統合テスト、CI の PostgreSQL サービス、本パケット、README |

差分の再現:

```powershell
git log --oneline 314264f..HEAD
git diff --stat 314264f..HEAD
```

## 2. マイグレーション

- 名称: `0000_identity` (`packages/db/migrations/0000_identity.sql`)
- ジャーナル: `packages/db/migrations/meta/_journal.json` に 1 エントリのみ (`idx: 0`)
- 空の DB から適用して作られるテーブル (9 個):
  `account`, `audit_logs`, `guest_sessions`, `identity_merges`, `principals`, `session`, `user`, `user_settings`, `verification`

### 自前テーブル

| テーブル | 要点 |
| --- | --- |
| `principals` | `id uuid` 主キー。`kind in ('guest','user')` と `(kind = 'user') = (user_id is not null)` を CHECK で強制。`user_id` は UNIQUE かつ `user(id)` へ `ON DELETE CASCADE`。 |
| `guest_sessions` | `principal_id` UNIQUE (1 principal に 1 セッション)、`token_hash` UNIQUE。`expires_at` に索引。`principal_id` は CASCADE。生トークンは保存しない。 |
| `identity_merges` | `merge_key` UNIQUE で冪等性を担保。`status in ('pending','completed','failed')`。`source_principal_id` は `ON DELETE SET NULL`、`target_principal_id` は CASCADE。 |
| `user_settings` | `principal_id` 主キー。`desired_retention numeric(5,4)` 既定 `0.9000`、CHECK で `0.70..0.97`。 |
| `audit_logs` | `metadata jsonb` に CHECK 制約 `not jsonb_exists_any(metadata, array['front','back','content','note','notes','text','answer','question'])` を置き、学習内容の混入を DB 層で拒否。`created_at` と `actor_principal_id` に索引。actor 参照は `ON DELETE SET NULL`。 |

自前テーブルの時刻列はすべて `timestamp with time zone`。接続は `packages/db/src/client.ts` で `TimeZone = Asia/Tokyo` を固定する。

### Better Auth 生成テーブル

`user` / `session` / `account` / `verification` は `packages/db/src/schema/auth.generated.ts` から生成され、手編集は禁止。`bun run db:auth-schema:check` が `auth@1.6.25` の再生成結果と 1 バイト単位で比較する。

**既知の差分**: 生成分の時刻列は `timestamp` (タイムゾーンなし) で、計画の「すべての instant は TIMESTAMPTZ」を満たさない (`session.expires_at` など)。生成物を手編集しない方針を優先した。要レビュー判断。

## 3. 実行したコマンドと結果

すべて `main` からの分岐後の HEAD (Task 6 の変更を含む) で実行。ローカルは Windows 11 + Bun 1.3.14、DB は WSL2 Ubuntu の Docker 上の `postgres:18.4-bookworm` (`127.0.0.1:55432`)。

| コマンド | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | exit 0 / `Checked 217 installs across 336 packages (no changes)` |
| `bun run db:migrate` (既存 DB) | exit 0 / `migrations applied successfully` (適用済みのため差分なし) |
| `bun run db:migrate` (空の検証用 DB) | exit 0 / 上記 9 テーブルを新規作成 |
| `bun run check` | exit 0 / Biome 53 ファイル、typecheck 4 パッケージ、Vitest **9 ファイル 82 テスト全て pass** |
| `bun run build` | exit 0 / api バンドル 765 modules 2.48 MB、web `dist/assets/index-BhTvGR6K.js` 190.47 kB (gzip 60.07 kB) |
| `bun run db:auth-schema:check` | exit 0 / `auth.generated.ts は auth@1.6.25 の生成結果と一致します` |

「空の検証用 DB」はテスト用インスタンス上に `tango_ci_verify` を作成して `0000_identity` を適用し、テーブル一覧を確認したうえで破棄した。既存のテスト DB は破壊していない。

### テスト内訳 (合計 82)

| ファイル | 件数 |
| --- | --- |
| `apps/api/src/features/auth/provider-routes.test.ts` | 18 |
| `packages/shared/src/errors/app-error.test.ts` | 15 |
| `apps/api/src/features/auth/auth-routes.test.ts` | 13 |
| `packages/shared/src/time/learning-day.test.ts` | 11 |
| `apps/api/src/features/auth/guest-service.test.ts` | 8 |
| `apps/api/src/features/auth/identity-completion-service.test.ts` | 6 |
| `packages/db/src/repositories/principal-repository.test.ts` | 6 |
| `apps/api/src/features/auth/identity-flow.integration.test.ts` | 4 |
| `tests/config/workspace.test.ts` | 1 |

実 DB を使うのは `principal-repository.test.ts`、`identity-completion-service.test.ts`、`identity-flow.integration.test.ts` の 3 ファイル。

### 通し統合テストが押さえている経路

`apps/api/src/features/auth/identity-flow.integration.test.ts` は実 DB に対し HTTP 境界から通す。Better Auth と Turnstile のみ差し替える。

1. ゲスト開始 → `/api/session` がゲストとして解決 → `promoted` で正式化 → 同一 `mergeKey` の再送が `existing` に収束 → principal ID が引き継がれる。
2. ゲスト無しで `created` → 別ゲストを開始 → `merged` → 取り込み後のゲスト Cookie はログアウト後も再利用不能 (401) → principal ID は不変。
3. Better Auth セッション無しの `/api/identity/complete` は 401 で、ゲスト Cookie を消さない。
4. `principals` / `guest_sessions` / `identity_merges` / `audit_logs` の全文字列を連結しても生トークンは出現せず、HMAC ハッシュのみが存在する。

### CI

`.github/workflows/ci.yml` は `postgres:18.4-bookworm` をサービスとして起動し、ヘルスチェック通過を待ってから、空の DB へマイグレーション適用 → 認証統合テスト → Better Auth スキーマ再生成比較 → `check` → `build` の順に実行する。`TZ` / `PGTZ` は `Asia/Tokyo` に揃えてローカルとの差を消してある。

**未検証**: この CI 変更は push していないため GitHub 上で実行されていない。ローカルでは各ステップ相当を個別に実行して成功を確認済み。

## 4. 手動 OAuth 確認 (未実施)

計画 Task 6 Step 4 の 5 シナリオは **未実施**。実在の Google / GitHub OAuth アプリと対話的なブラウザ操作が必要で、この作業環境では実行できなかった。

| # | シナリオ | 状態 |
| --- | --- | --- |
| 1 | 新規 Google ログインが `/auth/complete` に到達し正式 principal を作る | 未実施 |
| 2 | ログイン済み Google ユーザーが GitHub を明示的に連携 | 未実施 |
| 3 | Google が残る場合のみ GitHub 連携解除が成功 | 未実施 |
| 4 | 同一メールの未連携プロバイダのサインインで日本語の連携案内が出る | 未実施 |
| 5 | ゲストのデータ principal が昇格/統合され、成功後にのみゲスト Cookie が消える | 未実施 |

代替の自動検証として押さえてある範囲:

- シナリオ 1・5 は `identity-flow.integration.test.ts` が HTTP 境界で等価な経路を検証している (Better Auth のセッション読み取りのみ差し替え)。
- シナリオ 4 のエラー表現は `provider-routes.test.ts` が `ACCOUNT_NOT_LINKED` の日本語メッセージとして検証している。
- シナリオ 2・3 の連携/解除そのものは Better Auth の `linkSocial` / `unlinkAccount` に委ねており、設定側 (`disableImplicitLinking: true`, `allowUnlinkingAll: false`, `freshAge: 600`) を `provider-routes.test.ts` が検証している。実際のプロバイダ往復は未検証。

**リリース前に実機確認が必要**。

## 5. セキュリティ上重要な設定名

値は一切リポジトリに存在しない。名前のみを記す。

### 環境変数 (`apps/api/src/env.ts` の Zod スキーマで検証)

| 名前 | 内容 |
| --- | --- |
| `APP_ENV` | `development` / `test` / `production` |
| `APP_ORIGIN` | 信頼する唯一のオリジン。`https:` かどうかで Cookie の `Secure` を決める |
| `DATABASE_URL` | 接続 URL。ログには決して出さない |
| `GUEST_TOKEN_PEPPER_FILE` | ゲストトークン HMAC のペッパーを収めたファイルのパス |
| `TURNSTILE_SECRET_FILE` | Cloudflare Turnstile のシークレットのファイルパス |
| `BETTER_AUTH_SECRET_FILE` | Better Auth の署名・暗号化シークレットのファイルパス |
| `GOOGLE_CLIENT_ID` | 公開値 |
| `GOOGLE_CLIENT_SECRET_FILE` | Google クライアントシークレットのファイルパス |
| `GITHUB_CLIENT_ID` | 公開値 |
| `GITHUB_CLIENT_SECRET_FILE` | GitHub クライアントシークレットのファイルパス |

秘密値は環境変数に直接置かず、必ずファイル経由で読む (`readSecretFile`)。読み取り失敗・空ファイルは日本語のエラーで即座に落ち、内容はログに出さない。

### Cookie

- ゲスト: 名前 `tango_guest`、`HttpOnly`、`SameSite=Lax`、`Path=/`、`Domain` 属性なし (Host-only)、`Secure` は `APP_ORIGIN` が HTTPS のときのみ、`Max-Age` 90 日。
- 正式セッション: Better Auth の `advanced.defaultCookieAttributes` で `httpOnly` / `sameSite: 'lax'` / `path: '/'` を指定し `domain` は付けない。`crossSubDomainCookies` は未設定。

### Better Auth の主要設定 (`apps/api/src/features/auth/better-auth.ts`)

`basePath: '/api/auth'`、`trustedOrigins: [APP_ORIGIN]`、`emailAndPassword.enabled: false`、`socialProviders` は Google と GitHub のみ、`account.encryptOAuthTokens: true`、`account.storeStateStrategy: 'database'`、`accountLinking.disableImplicitLinking: true`、`allowUnlinkingAll: false`、`session.expiresIn` 30 日 / `updateAge` 1 日 / `freshAge` 600 秒、`user.deleteUser.enabled: false`、`telemetry.enabled: false`、`advanced.disableCSRFCheck: false`、`advanced.disableOriginCheck: false`、`plugins: []`。

### 監査ログ

`audit_logs.metadata` は DB の CHECK 制約で学習内容らしきキー (`front`, `back`, `content`, `note`, `notes`, `text`, `answer`, `question`) を拒否する。`onError` はリクエスト ID・エラーコード・スタックのみを内部ログへ出し、Cookie とリクエストボディは出さない。

## 6. 初回リリースの既知の除外事項

仕様で明示された除外 (Phase 1 で対応しないことが正しい項目):

- 内蔵のスクレイピングと LLM 実行
- Anki `.apkg` 互換、カスタムノートタイプ/テンプレート、穴埋め (cloze)
- 画像・音声のアップロードと外部メディア埋め込み
- オフライン学習、PWA 同期、複数端末のリアルタイム同期
- FSRS パラメータの個人最適化、一括再スケジュール、非空アカウントへの学習履歴統合
- メール/パスワード認証と Discord OAuth

Phase 1 時点で意図的に未実装のもの:

- ドメインテーブル (デッキ、カード、レビュー等) はまだ無い。統合時の移送は `moveOwnedDomainRows` を Phase 2 で埋める。
- アカウント削除は Phase 4 で確認フローを備えるまで無効。
- レート制限は Turnstile によるゲスト開始の抑止のみ。汎用のレート制限は後続フェーズ。
- `apps/web` は雛形のみ。`/auth/complete` の画面実装は後続フェーズ。

## 7. Phase 2 が依存するインターフェース

これらは Phase 2 で変更せずに使える契約として固定する。

### `Actor` / `ServiceContext` (`packages/shared/src/contracts/actor.ts`)

```ts
export type Actor =
  | { kind: 'guest'; principalId: string; guestSessionId: string }
  | { kind: 'user'; principalId: string; userId: string }

export type ServiceContext = {
  actor: Actor
  requestId: string
  now: Temporal.Instant
}
```

ドメインデータの所有者は常に `principalId` で一意に決まる。ゲストと正式利用者を型で区別しつつ、所有権の表現は 1 つに保つ。取得は `requireServiceContext(context)` 経由で、`now` を直接読まない。

### `DatabaseTransaction` (`packages/db/src/client.ts`)

```ts
export type Database = PostgresJsDatabase<DatabaseSchema>

export type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0]
```

### `PrincipalRepository` (`packages/db/src/repositories/principal-repository.ts`)

```ts
export type IdentityCompletionOutcome = 'created' | 'promoted' | 'merged' | 'existing'

export interface PrincipalRepository {
  findByUserId(userId: string): Promise<PrincipalRecord | null>
  findActiveGuestByTokenHash(tokenHash: string, now: Date): Promise<GuestSessionRecord | null>
  createGuest(input: { tokenHash: string; now: Date; expiresAt: Date }): Promise<GuestSessionRecord>
  completeIdentity(input: {
    userId: string
    guestTokenHash: string | null
    mergeKey: string
    now: Date
  }): Promise<IdentityCompletionResult>
  touchGuest(input: { sessionId: string; now: Date; expiresAt: Date }): Promise<void>
  revokeGuest(sessionId: string, now: Date): Promise<void>
  purgeExpiredGuests(input: { now: Date; limit: number }): Promise<PurgeExpiredGuestsResult>
}
```

### Phase 2 の拡張点

```ts
export async function moveOwnedDomainRows(
  sourcePrincipalId: string,
  targetPrincipalId: string,
  _tx: DatabaseTransaction,
): Promise<void>
```

`completeIdentity` の統合分岐から同一トランザクション内で呼ばれる。Phase 2 でデッキ・カード等を追加する際は、この関数の中だけを拡張すれば統合の原子性が保たれる。Phase 1 では移送対象が存在しないため中身は空で、統合の事実は同トランザクションの `identity_merges` 行が記録する。

## 8. 計画からの逸脱

| # | 内容 | 理由 |
| --- | --- | --- |
| 1 | Better Auth CLI は `@better-auth/cli@1.6.25` ではなく素の `auth@1.6.25` | `@better-auth/cli` は npm に存在しない。`auth@1.6.25` の SLSA provenance を検証済み |
| 2 | 生成された auth テーブルの時刻列が `timestamp` (タイムゾーンなし) | 生成物の手編集を禁じているため。自前テーブルは全て TIMESTAMPTZ |
| 3 | `audit_logs` の CHECK 制約の秘匿キーをリテラル埋め込みに変更 | drizzle-kit がバインドパラメータを DDL へ展開できず `$1..$8` を出力したため |
| 4 | `biome.json` から `**/*.generated.ts` と `packages/db/migrations` を除外 | Biome の整形が生成物のドリフト検査と衝突するため |
| 5 | `better-auth.config.ts` を完全に環境変数非依存にした | スキーマ生成はオプションの構造だけで決まる。CLI 実行に接続情報やシークレットを要求しないため。実行時の入口は `better-auth.ts` の `createAuth` のみ |
| 6 | `PrincipalRepository` に `purgeExpiredGuests` と `moveOwnedDomainRows` を追加 (計画のファイル一覧外) | 期限切れゲストの削除ジョブと、Phase 2 の統合移送のための拡張点。いずれも Phase 1 の要求から導かれる |
| 7 | ルート `vitest.config.mts` を追加し `fileParallelism: false` | 実 DB を使うテストファイルが並列実行され、各々の `TRUNCATE` が互いを壊していた。単一テストインスタンスを共有する構成での根本対処 |
| 8 | `@tango/db` に `./test` サブパスエクスポートと `dumpIdentityText` を追加 (計画のファイル一覧外) | 統合テストのヘルパを `apps/api` から使うため。生トークン非保存の検証に生 SQL が要るが、`apps/api` に `drizzle-orm` 依存を足さずに済ませた |
| 9 | `README.md` は修正ではなく新規作成 | 元々存在しなかった |
| 10 | **`.env.example` を更新できていない** | 権限設定によりこのファイルの読み書きが拒否される。下記の対応が必要 |

### 未解決: `.env.example`

Task 4 と Task 5 で追加した以下の環境変数が `.env.example` に反映されていない。手作業での追記が必要。

```
GUEST_TOKEN_PEPPER_FILE
TURNSTILE_SECRET_FILE
BETTER_AUTH_SECRET_FILE
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET_FILE
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET_FILE
```

### 運用上の注意

WSL2 の VM はアイドルで停止し、テスト用 PostgreSQL コンテナも一緒に落ちる。テスト実行中は keep-alive プロセスを立てておく必要がある。

## 9. レビューで特に見てほしい点

1. **識別処理の競合**: `completeIdentity` の 4 分岐 (`created` / `promoted` / `merged` / `existing`) が単一トランザクションで、かつ `merge_key` の UNIQUE 制約だけで冪等性を担保できているか。同一ユーザーの並行コールバック、ゲスト作成時の `token_hash` 衝突リトライ (最大 5 回) の扱い。
2. **`/api/auth/*` を `requestContext` より前に置いた判断**: 失効したゲスト Cookie がログインを妨げないようにするためだが、認証文脈を通さない経路を作ることの是非。
3. **ゲスト Cookie の消去タイミング**: `/api/identity/complete` は取り込み成功後にのみ消し、失敗時は残す。一方 `requestContext` は解決失敗時に消す。この非対称が正しいか。
4. **Better Auth 設定**: 上記 5 節の一覧が仕様の意図を満たしているか。特に `storeStateStrategy: 'database'` (追加テーブルは生じない)、`allowDifferentEmails: true` と `disableImplicitLinking: true` の組み合わせ。
5. **生成 auth テーブルの `timestamp`**: TIMESTAMPTZ 方針との差をこのまま許容してよいか。
6. **監査ログの秘匿**: DB の CHECK 制約だけで学習内容の混入を防ぐ設計の十分性。
