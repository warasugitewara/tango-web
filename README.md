# Tango

FSRS ベースの間隔反復学習 Web アプリ。日本語 UI、`Asia/Tokyo` 固定、学習日境界は 04:00 JST。

段階的に実装している。`feat/pre-release-study` では、身内向けプレリリースに必要なデッキ・カード・取り込み・FSRS学習画面までを提供する。

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

## プレリリース配置

`infra/pre-release` は Debian 12/13 LXC 上の Docker Compose を想定する。構成はアプリ、PostgreSQL、Cloudflare Tunnel の3サービスで、ホストへポートを公開しない。起動時にアプリコンテナがマイグレーションを1回適用してからAPIを開始し、同じオリジンでSPAも配信する。

### 1. 資格情報を用意する

```sh
cd infra/pre-release
cp .env.example .env
install -d -m 700 /etc/tango/secrets
```

`.env` には公開してよいTurnstile site keyとOAuth client ID、各secret fileの絶対パスだけを書く。secret fileは所有者だけが読めるよう `chmod 600` にする。

- `database_url`: `postgresql://tango:<URLエンコード済みパスワード>@tango-postgres:5432/tango`
- `postgres_password`: 上記URLと同じ生パスワード
- `guest_token_pepper`: 十分に長いランダム値
- `turnstile_secret` / `better_auth_secret`
- `google_client_secret` / `github_client_secret`
- `cloudflare_tunnel_token`

Cloudflare側では `tango.warasugi.com` のTunnel公開ホスト名を `http://tango-app:3000` へ向ける。

### 2. 構成を検証して起動する

```sh
docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env -f compose.yml up -d --build --wait
docker compose --env-file .env -f compose.yml ps
```

目的はPostgreSQLを外部公開せず、Cloudflare Tunnelだけを入口にすること。利点はLXC側のポート開放が不要な点。リスクはTunnelまたは単一LXCの停止でサービス全体が停止する点と、起動時DDLが長引く可能性がある点。更新前にバックアップを取得し、マイグレーションログを確認する。

### 3. 1日1回バックアップする

`backup.sh` はJSTの日付ごとに1個だけ、既定で `/var/backups/tango` へPostgreSQL custom dumpを原子的に保存する。rootのcronまたはsystemd timerから1日1回実行する。

```sh
chmod +x backup.sh
BACKUP_DIR=/var/backups/tango ./backup.sh
```

バックアップ先は別ディスクまたはProxmox Backup Serverでも複製する。プレリリースではPITRを提供しないため、最後のdump以降の更新は復元できない。

### ロールバック

アプリだけを戻す場合は直前のGit commitへ切り替え、同じ `docker compose ... up -d --build --wait` を実行する。`docker compose down` はDBのnamed volumeを保持するが、`down -v` はデータを消すため実行しない。DBスキーマを戻す必要がある場合は、先にサービスを停止してバックアップから別DBへ復元し、検証後に切り替える。
