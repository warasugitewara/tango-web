# Tango

FSRS ベースの間隔反復学習 Web アプリ。日本語 UI、`Asia/Tokyo` 固定、学習日境界は 04:00 JST。

段階的に実装している。現在は **Phase 1 (基盤と識別)** まで。

- 仕様: `docs/superpowers/specs/2026-08-01-tango-spaced-repetition-design.md`
- 実装計画: `docs/superpowers/plans/2026-08-01-tango-implementation-index.md`
- Phase 1 レビューパケット: `docs/reviews/phase-1-review.md`

## 構成

Bun ワークスペースのモノレポ。

| パッケージ | 役割 |
| --- | --- |
| `apps/api` | Bun / Hono の HTTP API。Better Auth 連携と自前のゲストセッション |
| `apps/web` | React / Vite の SPA |
| `packages/db` | Drizzle スキーマ、マイグレーション、リポジトリ |
| `packages/shared` | 実行文脈・エラー契約・学習日の計算 |

## 必要なもの

- Bun 1.3.14
- PostgreSQL 18 (テストと開発用。`infra/test/compose.yml` を使う)

## セットアップ

```powershell
bun install --frozen-lockfile
```

`.env.example` を `.env` にコピーし、値を埋める。シークレットは環境変数へ直接書かず、パスを指す `*_FILE` 変数からファイルとして読み込む。

## テスト用データベース

統合テストは実際の PostgreSQL に接続する。本番とはポートも認証情報も共有しない。

```powershell
docker compose -f infra/test/compose.yml up -d --wait
```

既定の接続先は `postgres://tango_test:tango_test@127.0.0.1:55432/tango_test`。`TEST_DATABASE_URL` で上書きできる。

停止するには次を実行する。

```powershell
docker compose -f infra/test/compose.yml down
```

## コマンド

| コマンド | 内容 |
| --- | --- |
| `bun run dev` | 全アプリを開発モードで起動 |
| `bun run check` | Biome、型検査、テストを順に実行 |
| `bun run check:fix` | Biome の自動修正 |
| `bun run test` | Vitest を 1 回実行 |
| `bun run build` | 全パッケージをビルド |
| `bun run db:generate` | スキーマからマイグレーションを生成 |
| `bun run db:migrate` | `DATABASE_URL` へマイグレーションを適用 |
| `bun run db:auth-schema` | Better Auth の生成スキーマを再生成 |
| `bun run db:auth-schema:check` | 生成スキーマがコミット済みの内容と一致するか検査 |

`packages/db/src/schema/auth.generated.ts` は `auth@1.6.25` の生成物。手で編集せず、再生成してコミットする。

## メンテナンスジョブ

期限切れのゲスト principal を削除する。

```powershell
bun apps/api/src/jobs/purge-expired-guests.ts
```

結果は JSON で標準出力に出る。失敗時は終了コード 1。
