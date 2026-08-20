# Tango プレリリース設計

## 目的

ログイン導線を一切出さないまま、デッキ・カード・FSRS復習が実際に使えるプレリリースを `tango.warasugi.com` へ出す。対象利用者は本人と数人の知人。

確定済みの `docs/superpowers/specs/2026-08-01-tango-spaced-repetition-design.md` を上位仕様とし、本書はそこからプレリリース向けに切り出す範囲と、切り出しに伴う差分だけを定義する。上位仕様と矛盾する記述は本書が誤りであり、上位仕様を優先する。

## 前提

- Phase 1（基盤と識別）は完了済み。principal、ゲストセッション、Better Auth、監査基盤、時刻規約は既存のものをそのまま使う。
- Phase 2〜4は未着手。本書はPhase 2とPhase 3の一部だけを先行実装する。
- 端折った項目はすべて `docs/todo/pre-release-deferred.md` に記録する。

## 方針

最終スキーマのまま薄く作る。テーブルと列は上位仕様の最終形で作り、UIと機能だけを削る。migrationは前方専用のため、列を後から足すより最初から正しい形で作る方が安全で、空の列を持つコストはゼロである。

復習取引だけは例外的に完全実装する。楽観ロック、冪等キー、`review_events` への追記を最初から入れる。復習履歴は後から復元できないため、ここを省くと利用者の学習データが失われる。

## スコープ

### 入れる

- デッキの作成・一覧・更新・削除
- カードの作成・一覧・編集・削除
- JSON/CSV を貼り付けての一括取り込み（重複検出なし）
- FSRS-6 の復習キューと4段階評価、04:00 JST 起点の学習日
- ゲストのみで完結する最小UI 3画面

### 入れない

タグ、ゴミ箱の復元UI、重複プレビュー付き取り込み、エクスポート、バックアップ envelope、undo、ダッシュボード集計、希望保持率の設定UI、カード検索、デッキ間移動、E2Eテスト、ログイン導線。

## データモデル

`packages/db/src/schema/content.ts` と `packages/db/src/schema/study.ts` を追加し、migration `0007_content_study.sql` にまとめる。

作成するテーブルと列は上位仕様の Domain Model に従う。

- `decks`: UUIDv7、principal FK、名前、正規化名、説明、並び順、新規カード上限（既定20）、`archived_at`、`trashed_at`、timestamps
- `cards`: UUIDv7、deck FK、front/back Markdown、metadata JSONB、content hash、status、source key / external ID / source URL / source title、`trashed_at`、timestamps
- `card_schedules`: card と1対1。due、stability、difficulty、elapsed/scheduled days、learning steps、reps、lapses、state、last review、scheduler version、request retention、楽観ロック用 `version`
- `review_events`: 追記専用。principal、card、session、rating、before/after のスケジュール snapshot、サーバ側レビュー時刻、冪等キー、任意の応答時間
- `study_sessions`: principal、スコープ（全デッキ / 選択デッキ）、学習日、活動・完了時刻

作成しないテーブルは `tags`、`card_tags`、`import_batches`、`import_candidates`。いずれも独立しており、後から前方migrationで追加できる。

インデックスは principal / deck / trash、カードの content hash、`(deck_id, source_key, external_id)` の部分ユニーク（NULL を許し、非NULLの重複を拒否）を張る。

`moveOwnedDomainRows` に `decks.principal_id` の移送を実装する。プレリリースではログイン導線が無く統合は発生しないが、未実装のまま後でログインを有効にすると統合時にデッキが cascade で失われる。

削除はすべて `trashed_at` を打つ論理削除とし、通常の読み取りから隠す。復元UIは出さないため、UIで戻せない旨を明示する。

## API

既存の `/api/guest/start`、`/api/session`、`/api/auth/*`、`/health/live` は変更しない。次を追加する。

| メソッドとパス | 役割 |
| --- | --- |
| `GET /api/decks` | デッキ一覧。カード枚数と当日の残り枚数を含む |
| `POST /api/decks` | デッキ作成 |
| `PATCH /api/decks/:deckId` | 名前・説明・新規カード上限の更新 |
| `DELETE /api/decks/:deckId` | 論理削除 |
| `GET /api/decks/:deckId/cards` | カード一覧（ページング） |
| `POST /api/decks/:deckId/cards` | カード作成 |
| `PATCH /api/cards/:cardId` | カード編集 |
| `DELETE /api/cards/:cardId` | 論理削除 |
| `POST /api/decks/:deckId/import` | JSON/CSV の一括取り込み |
| `POST /api/study/sessions` | 学習セッション開始 |
| `GET /api/study/sessions/:sessionId` | 現在のカード、4通りの間隔プレビュー、残り枚数 |
| `POST /api/study/reviews` | 評価の投稿 |

契約は `packages/shared/src/contracts/` に Zod の strict スキーマとして置く。`reviewSubmitSchema` は上位計画に定義済みの形をそのまま使い、`sessionId`、`cardId`、`rating 1..4`、`expectedScheduleVersion`、`idempotencyKey` を受け取り、クライアント時刻は受け取らない。

所有権の検査は必ず SQL の述語かトランザクション内で行う。全件取得後にアプリケーションメモリ上で認可しない。

カード本文は front / back とも最大20,000文字。生HTMLは拒否する。日時応答はすべて `+09:00` を明示した RFC 3339 とする。

取り込みは重複検出を行わない。同一内容を2回投入すれば2枚作成される。受け付ける形式は上位仕様の `tango.content` version 1 の JSON と CSV。

## 復習取引

1トランザクションで次を順に行う。

1. principal / セッション / カードの関係を認可する
2. 冪等キーが使用済みなら、スケジュールを比較する前に保存済みの結果を返す
3. `card_schedules` を `FOR UPDATE` でロックし `expectedScheduleVersion` と突き合わせる
4. FSRS の結果を適用する
5. `card_schedules` を更新し `version` をインクリメントする
6. `review_events` に before / after の snapshot ごと追記する
7. 保存された遷移結果を返す

バージョン不一致は `409 STUDY_STATE_CONFLICT` を返す。クライアントはサーバの応答前に次のカードへ進まない。再送は同一の冪等キーを使う。冪等キーの一意性は principal 単位。

キュー規則は、期限到来の復習・再学習カードを due 時刻順で先に出し、その後に新規カードを出す。新規は1学習日あたり既定20枚でデッキごとに上書きできる。当日の新規枚数は `review_events` から学習日で数え、集計専用の可変テーブルは作らない。

FSRS は `ts-fsrs` 5.4.1 の FSRS-6 を薄いアダプタの裏に隔離する。希望保持率はプレリリースでは `0.90` 固定。`schedulerVersion` は `'ts-fsrs@5.4.1/fsrs-6'` を固定文字列で記録する。アダプタにはライブラリ更新による出題間隔の暗黙変化を検知する characterization test を置く。

レビュー時刻はサーバが生成する。クライアントの時計は信用しない。

## UI

画面は3つ。ルーティングは `react-router`、サーバ状態は `@tanstack/react-query`、Markdown は `react-markdown` と `rehype-sanitize` で生HTMLを無効にしたまま描画する。

**デッキ一覧（トップ）**: ゲストCookieが無ければ「はじめる」のみを表示し、Turnstile を通してゲストを開始する。開始後はデッキ一覧、各デッキの当日残り枚数、学習ボタン、全デッキ学習ボタンを表示する。プレリリースであることとCookie削除でデータが復元できないことを常時表示する。ログイン導線は置かない。

**デッキ詳細**: カード一覧、作成、編集、削除、JSON/CSV貼り付け取り込み。

**学習画面**: 表 → 「答えを見る」 → 裏と4段階の評価ボタン。各ボタンに次回間隔のプレビューを表示する。上部に残り枚数を表示する。評価はサーバの応答を待ってから次のカードへ進む。

テストは `@testing-library/react` と `jsdom` によるコンポーネント単位まで。

## ゲスト起点

Turnstile は維持する。無効化するには production で迂回できないことを保証する分岐とテストが必要になり、維持するより作業が増えるうえ Phase 1 の fail-closed を自ら緩めることになる。ローカル開発は Cloudflare 公式のテストキーを使う。

`POST /api/guest/start` は失効したゲストCookieを持つ要求を 401 にせず、Cookie を破棄して新規発行へ進む。現在は `requestContext` がゲスト解決失敗を `UNAUTHENTICATED` として返すため初回が必ず失敗する。回帰テストを付ける。

公開ホストは `tango.warasugi.com` を使う。`APP_ENV=production` は `APP_ORIGIN` をこの値に固定しているため、オリジン検証の改修は不要である。

ゲストCookieは https 経由のため `Secure; HttpOnly; SameSite=Lax; Path=/`、`Domain` なし、90日で発行される。

## デプロイ

Proxmox 上の LXC 1台に Docker Compose で3コンテナを配置する。

- `tango-app`: Bun と Hono。API と SPA を同一オリジンで配信する
- `tango-postgres`: PostgreSQL 18.4。named volume で永続化する
- `cloudflared`: Cloudflare Tunnel。`tango.warasugi.com` を `tango-app` へ向ける

Phase 4 の最終形（App と DB の LXC 分離）の部分集合であり、後から切り出せる。ポートは開放せず、PostgreSQL は compose 内部ネットワークにのみ露出する。

`apps/web` のビルド成果物は Hono の静的配信に載せる。ゲストCookieと Better Auth のオリジン検査が同一オリジンを前提とするため、フロントを別ドメインに分離しない。

秘密値は環境変数に置かずファイルをマウントし `*_SECRET_FILE` 経由で読む。ログイン導線を出さない場合でも OAuth の資格情報は起動時に必須である。

アプリ起動前にワンショットで `db:migrate` を実行する。

バックアップは Phase 4 の pgBackRest / WAL を作らない。代わりに `pg_dump` を1日1回ローカルボリュームへ出力する cron のみ入れる。

## 依存

新規に追加する依存はすべて 2026-08-01 の実装計画でピン留め済みであり、追加承認を要しない。

| パッケージ | バージョン | 用途 |
| --- | --- | --- |
| `react-router` | 8.3.0 | 3画面のルーティング |
| `@tanstack/react-query` | 5.101.4 | サーバ状態と更新後の再取得 |
| `react-markdown` | 10.1.0 | カード本文の描画 |
| `rehype-sanitize` | 6.0.0 | 生HTMLの無効化 |
| `ts-fsrs` | 5.4.1 | FSRS-6 スケジューラ |
| `csv-parse` | 7.0.1 | CSV 取り込み |
| `@testing-library/react` | 16.3.2 | コンポーネントテスト |
| `jsdom` | 30.0.1 | コンポーネントテストの実行環境 |

ピン留めリスト外のパッケージは追加しない。

## テスト方針

- 実 PostgreSQL に対するリポジトリテスト。所有者境界、部分ユニーク制約、論理削除の不可視化、統合時のデッキ移送を検証する
- 復習取引の並行性テスト。バージョン競合、冪等キー再送、学習日境界を実DBで検証する
- FSRS アダプタの characterization test
- API の HTTP 境界テスト。認可、検証失敗、`409 STUDY_STATE_CONFLICT`
- UI のコンポーネントテスト

`any`、`@ts-ignore`、広い型 assertion、routine な非null assertion は使わない。

## 受け入れ条件

1. ゲストとして開始し、デッキを作り、カードを手入力で追加し、復習して4段階評価を付けられる
2. JSON と CSV を貼り付けてカードを一括作成できる
3. 04:00 JST を跨いだときに当日の新規枚数が正しくリセットされる
4. 同じ冪等キーでの再送が二重に採点されない
5. 別のブラウザからアクセスしたとき、他人のデッキとカードが一切見えない
6. `bun run check`、`bun run build`、空DBへの `db:migrate` がすべて成功する
7. `docs/todo/pre-release-deferred.md` に端折った項目がすべて記録されている

## 残余リスク

- バックアップは `pg_dump` のみで PITR がない。障害時の復旧点は最大24時間前になる
- ゲストCookieを削除した利用者の学習データは復元できない。UIで明示する以上の対策は取らない
- 監視がない。障害は利用者からの報告で気づくことになる
- 重複検出がないため、同じ取り込みを繰り返すとカードが重複する
