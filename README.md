# Tango

FSRS ベースの間隔反復学習 Web アプリ。日本語 UI、`Asia/Tokyo` 固定、学習日境界は 04:00 JST。

段階的に実装している。`feat/pre-release-study` では、身内向けプレリリースに必要なデッキ・カード・取り込み・FSRS学習画面までを提供する。

- 仕様: `docs/superpowers/specs/2026-08-01-tango-spaced-repetition-design.md`
- 実装計画: `docs/superpowers/plans/2026-08-01-tango-implementation-index.md`
- Phase 1 レビューパケット: `docs/reviews/phase-1-review.md`

## 現状でできること

プレリリースとして `https://tango.warasugi.com` で稼働している。

- ゲストとして即開始できる（Cloudflare Turnstile を通す。ログインは不要）
- 単語帳とカードの作成・編集・削除（削除はゴミ箱へ入り、30日以内なら `/trash` から戻せる）
- JSON (`tango.content` v1) と CSV の貼り付け一括取り込み（重複検出はしない）
- FSRS-6 の出題キューと4段階評価。学習日は 04:00 JST 起点
- 進捗の集計（当日の完了枚数、連続学習日、直近7日の活動量、次回期限）
- Google / GitHub でログインし、ゲストの学習データを引き継ぐ
- ログイン済みアカウントへの別プロバイダの明示連携と解除

未実装の項目は `docs/todo/pre-release-deferred.md` にまとめている。

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

## セキュリティ境界

クライアントを書く場合は次の制約を満たす必要がある。

- **状態を変える要求には二重送信トークンが要る。** `GET /api/security/csrf` でトークンを取り、`X-Tango-CSRF` ヘッダへ載せる。Cookie と一致しなければ 403 になる。安全なメソッドには不要
- **`Origin` は公開オリジンと完全一致**でなければ 403。`Sec-Fetch-Site: cross-site` も拒否する
- `/api/auth/*` は Better Auth が自前で origin/CSRF を検証するため、上の検査から除外している
- **サインインは必ずブラウザから開始する。** Better Auth はサインイン応答で署名済み `state` Cookie を張り、コールバックで突き合わせる。`curl` やサーバ側 `fetch` で開始すると `state_mismatch` で失敗する
- `POST /api/guest/start` は 10 分あたり 10 回まで。超えると 429。送信元は HMAC の指紋として記録し、生の IP は保存しない
- 全応答に CSP、`Referrer-Policy`、`X-Content-Type-Options`、`Permissions-Policy`、`Cross-Origin-Opener-Policy` を付ける。HTTPS 配信時のみ HSTS も付ける
- CSP は Turnstile のために `https://challenges.cloudflare.com` を `script-src` / `connect-src` / `frame-src` へ許可している。ここを削るとゲスト開始が動かなくなる

## OAuth の設定

Google と GitHub のどちらも、**ローカルと本番の両方のリダイレクト URI を登録**する。片方だけだと `redirect_uri_mismatch` になる。

```
http://localhost:3000/api/auth/callback/google
https://tango.warasugi.com/api/auth/callback/google
http://localhost:3000/api/auth/callback/github
https://tango.warasugi.com/api/auth/callback/github
```

同じメールアドレスでも暗黙には結び付けない。連携は画面からの明示操作だけで行う。最後の 1 つは解除できない。

## メンテナンスジョブ

期限切れのゲスト principal を削除する。あわせて次も同じ実行で掃除する。専用の cron を増やさないための相乗りであり、ジョブ名が示す範囲より責務が広い。

- 濫用対策の試行記録（判定の窓を過ぎたもの）
- ゴミ箱の保持期限（30 日）を過ぎた削除済みデッキとカードの物理削除

```powershell
bun apps/api/src/jobs/purge-expired-guests.ts
```

結果は JSON で標準出力に出る。失敗時は終了コード 1。

## プレリリース配置

`infra/pre-release` は Debian 12/13 LXC 上の Docker Compose を想定する。構成はアプリとPostgreSQLの2サービスで、Cloudflare TunnelはLXCのsystemdサービスとして動かす。アプリはホストの`127.0.0.1:3000`だけへ公開する。起動時にアプリコンテナがマイグレーションを1回適用してからAPIを開始し、同じオリジンでSPAも配信する。

### 1. 資格情報を用意する

```sh
cd infra/pre-release
cp .env.example .env
install -d -m 700 /etc/tango/secrets
```

`.env` には公開してよいTurnstile site keyとOAuth client ID、各secret fileの絶対パスだけを書く。アプリは固定したUID/GID 1000で動くため、アプリ用secretだけを同じ所有者にし、親ディレクトリはroot以外が探索できない状態を維持する。PostgreSQL用パスワードはroot所有のままにする。

```sh
chown 1000:1000 \
  /etc/tango/secrets/database_url \
  /etc/tango/secrets/guest_token_pepper \
  /etc/tango/secrets/turnstile_secret \
  /etc/tango/secrets/better_auth_secret \
  /etc/tango/secrets/google_client_secret \
  /etc/tango/secrets/github_client_secret
chmod 400 \
  /etc/tango/secrets/database_url \
  /etc/tango/secrets/guest_token_pepper \
  /etc/tango/secrets/turnstile_secret \
  /etc/tango/secrets/better_auth_secret \
  /etc/tango/secrets/google_client_secret \
  /etc/tango/secrets/github_client_secret
chown root:root /etc/tango/secrets/postgres_password
chmod 600 /etc/tango/secrets/postgres_password
chmod 700 /etc/tango/secrets
```

- `database_url`: `postgresql://tango:<URLエンコード済みパスワード>@tango-postgres:5432/tango`
- `postgres_password`: 上記URLと同じ生パスワード
- `guest_token_pepper`: 十分に長いランダム値
- `turnstile_secret` / `better_auth_secret`
- `google_client_secret` / `github_client_secret`
Cloudflare側では `tango.warasugi.com` のTunnel公開ホスト名を `http://localhost:3000` へ向ける。

### 2. 構成を検証して起動する

```sh
docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env -f compose.yml up -d --build --wait
docker compose --env-file .env -f compose.yml ps
```

目的はPostgreSQLを外部公開せず、ホスト版Cloudflare Tunnelだけを入口にすること。利点はLXC側の外部向けポート開放が不要な点。リスクはTunnelまたは単一LXCの停止でサービス全体が停止する点と、起動時DDLが長引く可能性がある点。更新前にバックアップを取得し、マイグレーションログを確認する。

### 3. 1日1回バックアップする

`backup.sh` はJSTの日付ごとに1個だけ、既定で `/var/backups/tango` へPostgreSQL custom dumpを原子的に保存する。rootのcronまたはsystemd timerから1日1回実行する。

```sh
chmod +x backup.sh
BACKUP_DIR=/var/backups/tango ./backup.sh
```

バックアップ先は別ディスクまたはProxmox Backup Serverでも複製する。プレリリースではPITRを提供しないため、最後のdump以降の更新は復元できない。

### ロールバック

アプリだけを戻す場合は直前のGit commitへ切り替え、同じ `docker compose ... up -d --build --wait` を実行する。`docker compose down` はDBのnamed volumeを保持するが、`down -v` はデータを消すため実行しない。DBスキーマを戻す必要がある場合は、先にサービスを停止してバックアップから別DBへ復元し、検証後に切り替える。
