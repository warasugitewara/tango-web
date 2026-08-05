# Phase 1 Codex Review: 基盤と識別

- レビュー日: 2026-08-01
- 対象ブランチ: `feat/phase-1-foundation-identity`
- 対象範囲: `314264f..a70584f`
- 実装計画: `docs/superpowers/plans/2026-08-01-tango-01-foundation-identity.md`
- 仕様: `docs/superpowers/specs/2026-08-01-tango-spaced-repetition-design.md`
- Claude側完了報告: `docs/reviews/phase-1-review.md`
- 判定: **Phase 2進行不可（要修正・再レビュー）**

## Claudeへの作業指示

1. `C:\Users\waras\.claude\CLAUDE.md` を最優先で読む。
2. 本レビューの各指摘を、実装・実DBテスト・公式仕様で再現確認する。指摘を盲目的に適用しない。
3. P1をすべて修正してからP2、P3へ進む。Phase 2の機能実装には着手しない。
4. 修正には回帰テストを追加する。`any`、`@ts-ignore`、広い型assertion、非nullassertionによる回避は禁止。
5. 修正は論点ごとに日本語Conventional Commits形式で個別commitしてよい。commit前に `.gitignore`、status、diff、staged path、テストを確認する。pushは禁止。
6. 完了後に `docs/reviews/phase-1-review.md` の既知問題・検証結果・commit mapを更新し、Codexの再レビューを待つ。

## P0

なし。

## P1: 修正必須

### 1. 既存ゲストのCookieを上書きしてデータへアクセス不能になる

- 対象: `apps/api/src/features/auth/auth-routes.ts:48-69`
- 原因: `/api/guest/start` は正式セッションだけを拒否し、既存のguest actorを検査しない。
- 影響: 既存ゲストが再度開始すると、新しいCookieが唯一の旧生トークンを上書きする。旧principalの学習データを復元できない。
- 必要な修正: 既存guest actorでは現在のゲストセッションを返すか、明示的に拒否する。既存データを持つゲストで再開始してもCookieを変更しないHTTPテストを追加する。

### 2. 一時障害でもゲストCookieを削除する

- 対象: `apps/api/src/middleware/request-context.ts:97-104`
- 原因: `guestService.resolve()` の例外を種類に関係なく捕捉し、Cookieを削除する。
- 影響: DB一時障害や `touchGuest` 失敗だけで、唯一の生トークンを失い、ゲストデータへ永久にアクセス不能になる。
- 必要な修正: `UNAUTHENTICATED` と確認できた場合だけCookieを削除する。未知例外・DB障害では保持する回帰テストを追加する。

### 3. DB期限だけ延長し、ブラウザCookieを更新しない

- 対象: `apps/api/src/features/auth/guest-service.ts:158-165`、`apps/api/src/middleware/request-context.ts:97-100`
- 原因: `guest_sessions.expires_at` は延長するが、同じ生トークンのCookieを再発行しない。
- 影響: 毎日利用していても作成90日後にブラウザがCookieを破棄し、DB側に有効なデータが残ったままアクセス不能になる。
- 必要な修正: touchが実際に成功したかを返し、その場合だけCookieの `Max-Age` を再発行する。90日を超える継続利用をHTTP境界で検証する。

### 4. 同じゲストの並行昇格でuserIdを上書きできる

- 対象: `packages/db/src/repositories/principal-repository.ts:272-355`
- 原因: guest session/source principalをロックせず取得し、昇格UPDATEもprincipal IDだけを条件にする。
- 影響: 同じゲストを異なる2ユーザーが並行昇格すると、後続処理が `user_id` を上書きできる。将来の学習データ所有者が別アカウントへ変わる。
- 必要な修正: source/target/guest sessionを決定順で `FOR UPDATE` し、ロック後に有効性・kind・userIdを再確認する。昇格UPDATEは `kind = 'guest' AND user_id IS NULL` を条件にする。同一トークンを異なるユーザーが並行利用する実DBテストを追加する。

### 5. 統合後も旧guest principalが残り、移送後の書込み競合を防げない

- 対象: `packages/db/src/repositories/principal-repository.ts:324-327`
- 原因: 移送とゲストセッション失効後、source guest principalを削除しない。既にactor解決済みの別リクエストがsourceへ書き込む余地もある。
- 影響: Phase 2で移送後に旧principal配下へ新しいデータが作られ、正式ユーザーから見えないデータが残る。仕様の「転送成功後に旧guest principalを削除」にも違反する。
- 必要な修正: source削除まで同じtransactionへ含める。Phase 2のドメイン書込みがtransaction内でguest session/principalの有効性を再検証・ロックする所有権プロトコルも確定する。

### 6. purgeが期限延長済みゲストを削除できる

- 対象: `packages/db/src/repositories/principal-repository.ts:403-435`
- 原因: purge候補SELECTとDELETEが別autocommitで、DELETE時に `expires_at <= now` を再確認しない。
- 影響: 候補SELECT後に並行resolveが期限を延長しても、その有効ゲストprincipalと所有データを削除し得る。
- 必要な修正: `FOR UPDATE SKIP LOCKED` を使うtransaction、または期限条件を含む単一DELETEにする。touchとの競合テストを追加する。

### 7. TEST_DATABASE_URLの設定ミスで任意DBを破壊できる

- 対象: `packages/db/src/test/database.ts:17-18,81-84`
- 原因: 任意の `TEST_DATABASE_URL` を受け入れ、テスト専用DBか検証せず `TRUNCATE ... CASCADE` する。
- 影響: `bun run check` 実行時の環境変数設定ミスだけで、開発・本番DBを破壊できる。
- 必要な修正: DB名、host、専用marker、明示的な破壊許可フラグをtruncate前に検証し、不一致なら停止するテストを追加する。

## P2: Phase 2前に解決

### 1. 生のstackがログへ出て機密・学習内容を漏らし得る

- 対象: `apps/api/src/middleware/error-handler.ts:19-27`
- 現状: 未知例外の生stackをログへ出す。既存テストは接続URLを含む例外を作るが、レスポンスしか検査しない。
- 必要な修正: 安全な例外分類・内部エラーID・サニタイズ済み情報だけを記録する。Cookie、本文、接続URL、カード内容がログに出ないことを検証する。

### 2. production originとSecure Cookieがfail-open

- 対象: `apps/api/src/env.ts:4-20`、`apps/api/src/index.ts:31-50`
- 現状: `APP_ENV=production` でも任意scheme/originを受理し、HTTPなら正式・ゲストCookie双方の `Secure` を無効化する。
- 必要な修正: productionでは `APP_ORIGIN === 'https://tango.warasugi.com'` を必須にし、Secure Cookieを強制する起動時テストを追加する。

### 3. 実OAuthとACCOUNT_NOT_LINKEDの経路が未検証

- 対象: `apps/api/src/app.ts:32-34`、`apps/api/src/features/auth/provider-routes.test.ts:333-349`、`docs/reviews/phase-1-review.md` の手動OAuth確認
- 現状: Better Authのsame-email未連携エラーを日本語 `ACCOUNT_NOT_LINKED` 契約へ変換する実装がない。テストはcompletion serviceへAppErrorを直接注入しているだけ。計画Task 6 Step 4の5シナリオも全件未実施。
- 必要な修正: Better Authの実際のerror callbackを安定コードと日本語回復画面へ写像する。実adapter＋provider mockの統合テストを追加し、実OAuth 5シナリオを実施するか、計画変更の承認を得る。

### 4. Better AuthのinstantがTIMESTAMPTZではない

- 対象: `packages/db/src/schema/auth.generated.ts:10-70`、`packages/db/migrations/0000_identity.sql:20-57`
- 現状: session/token expiryを含むinstantが `timestamp without time zone`。製品仕様のTIMESTAMPTZ統一に違反する。
- 必要な修正: 生成物を直接手編集せず、再現可能な生成後変換またはcustom schemaでTIMESTAMPTZをSoTにする。対応不能なら仕様変更として明示承認を得る。

### 5. identity完了契約と冪等性キーが計画不適合

- 対象: `apps/api/src/features/auth/auth-routes.ts:24-27,113-125`、`packages/db/src/repositories/principal-repository.ts:254-269`
- 現状: APIは計画上の `actor/outcome` ではなく `outcome` だけを返す。任意UUIDを許し、UUIDv7を強制しない。記録済みmergeKeyが入力userIdに属するかも確認しない。
- 必要な修正: UUIDv7へ正規化・DB型をUUID化し、recorded targetのuserId一致を必須にする。レスポンス契約を計画どおりに戻す。

### 6. `.env.example` に必須キーがない

- 対象: `.env.example`
- 現状: `GUEST_TOKEN_PEPPER_FILE` がなく、READMEどおりコピーした環境は起動時検証に失敗する。
- 必要な修正: キーを追加し、env schemaとexampleの一致をCIテストする。

### 7. guest expiryがJST形式ではない

- 対象: `apps/api/src/features/auth/actor-resolver.ts:86-94`
- 現状: `Instant.toString()` により通常 `Z` で返り、公開JSON timestampの明示 `+09:00` 契約を満たさない。
- 必要な修正: `formatJst()` を使用し、HTTPレスポンスで検証する。

### 8. 壊れたJSON構文が500になる

- 対象: `apps/api/src/middleware/error-handler.ts:14-17`、`apps/api/src/features/auth/auth-routes.ts:39-47`
- 現状: HonoがJSON parseで投げる例外が未知例外として `500 INTERNAL_ERROR` になる。既存テストは型不一致JSONしか検証しない。
- 必要な修正: 壊れたJSON、不正Content-Type、過大bodyを安全な日本語 `VALIDATION_FAILED` へ正規化し、境界テストを追加する。

### 9. audit metadataの内容禁止がネストを検査しない

- 対象: `packages/db/src/schema/audit.ts:35,50-63`
- 現状: `jsonb_exists_any` はトップレベルキーしか検査せず、`{ payload: { front: '...' } }` を許す。
- 必要な修正: event別allowlist schemaを主防御にし、必要なら再帰的DB制約を補助として追加する。

## P3

1. `apps/api/src/jobs/purge-expired-guests.ts:53-68`: `--now` が明示 `+09:00` を強制しない。`parseJstInstant()` を再利用する。
2. DB停止時、3つの実DBテストの `afterAll` が未初期化handleへ `close()` を呼び、一次原因へ二次エラーを重ねる。安全な後処理にする。
3. `.claude/settings.local.json` が未追跡で残っている。機密は確認されなかったが、repositoryへ含めない方針ならignoreする。

## Codexで再実行した検証

| コマンド | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | 成功、依存関係変更なし |
| `bun run check` | 成功、9ファイル・82テストすべてpass |
| `bun run build` | 成功 |
| `bun run db:migrate` | 成功 |
| `bun run db:auth-schema:check` | 成功 |
| `git diff --check` | 成功 |

初回の `bun run check` はテスト用PostgreSQL停止により失敗した。専用Composeを起動後は全テスト成功。レビュー後、コンテナはvolumeを削除せず停止状態へ戻した。

## 再レビュー受付条件

- P1がすべて修正され、各競合・データ喪失経路に実DB/HTTP回帰テストがある。
- P2が解消されるか、仕様変更としてユーザーの明示承認が記録されている。
- `bun install --frozen-lockfile`、migration、`bun run check`、`bun run build`、Better Auth schema checkがすべて成功する。
- 実OAuth 5シナリオの結果、修正commit範囲、migration差分、既知制限が更新済みレビューpacketに記録されている。
- Phase 2の実装へ着手していない。

---

## 2026-08-02 修正・再レビュー状況

この節は上記2026-08-01レビュー指摘を履歴としてそのまま残し、後段に現在の解決状況だけを追記する。現在HEADは`b08ba5b`。Task 8/9はcommit許可待ちのworktree差分であり、存在しないcommit SHAは記載しない。P2-3の4ファイルだけがstage済み、その他はunstaged/untracked、pushなし、Phase 2未着手、Codex再レビュー待ち。

### P1 1〜7

| 指摘 | status | commit | 主要テスト / 根拠 | 独立review |
| --- | --- | --- | --- | --- |
| P1-1 既存ゲストCookie上書き | 解決 | `463eb20` | 既存guestで再開始してもtoken/Cookie/principalを維持するHTTP・identity flow回帰 | **PASS** |
| P1-2 一時障害時Cookie削除 | 解決 | `d12206a` | `UNAUTHENTICATED`時だけ削除し、DB/touch失敗では保持するHTTP回帰 | **PASS** |
| P1-3 DB期限のみ延長 | 解決 | `b3702c0` | touch成立時だけ同tokenのCookie `Max-Age`を再発行するservice/HTTP/統合回帰 | **PASS** |
| P1-4 並行昇格のuserId上書き | 解決 | `b676fbb` | 決定順`FOR UPDATE`、lock後再検証、条件付きUPDATE、異なる2 userの並行実DB回帰 | **PASS** |
| P1-5 統合元principal残存 | 解決 | `83cb66b` | owned row移送hook・merge記録・source削除を同一transactionで行うrepository/統合回帰 | **PASS** |
| P1-6 purge/touch競合 | 解決 | `4c3d3f9` | transaction＋`FOR UPDATE SKIP LOCKED`＋DELETE時条件再確認の実DB競合回帰 | **PASS** |
| P1-7 任意DB破壊 | 解決 | `c774a8b` | PostgreSQL scheme、loopback host、`_test` suffix、非productionを接続/TRUNCATE前に検証する6 tests | **PASS** |

P1の7 commit SHAとメッセージは`git log 314264f..b08ba5b`で照合した。

### P2 1〜9

| 指摘 | status | commit / 論理境界 | 主要テスト / 根拠 | 独立review |
| --- | --- | --- | --- | --- |
| P2-1 生stackログ | 解決 | `bc84fa0` | `error-handler.test.ts` 5 tests。raw message/stack、URL、本文を出さず、安全な分類・内部error ID・frameだけを記録 | **PASS** |
| P2-2 production origin/Secure fail-open | 解決 | `0156756` | `env.test.ts`を含む7 tests。production origin固定、正式/guest Cookie Secure強制 | **PASS** |
| P2-3 実OAuth / `ACCOUNT_NOT_LINKED` | **自動境界PASS、実OAuth 5シナリオ未実施** | **未commit（論理境界、P2-3の4ファイルだけstage済み）** | 実Better Auth callback＋実PostgreSQL adapter＋Google token endpoint mockの1 integration test、provider routesとの関連20 tests。`account_not_linked`を同一originの日本語`ACCOUNT_NOT_LINKED`画面へ写像し、暗黙linkしない。これは実provider OAuthではない | **PASS（自動境界）**。リリース前手動確認は残る |
| P2-4 Better Auth instant | 解決 | **未commit（論理境界、unstaged/untracked）** | 生成後変換test 2件、migration実DBtest 2件、drift check。生成schema/`0002`で12列すべてTIMESTAMPTZ、旧UTC壁時計を`AT TIME ZONE 'UTC'`で保持 | **PASS** |
| P2-5 identity完了契約/冪等性 | 解決 | `b08ba5b` | UUIDv7/DB uuid、記録済みtargetのuser所有者一致、`actor`/`outcome`応答をrepository/API/統合回帰で検証 | **PASS** |
| P2-6 `.env.example` | 解決 | **未commit（論理境界、unstaged）** | `env.test.ts`でruntime schemaとexampleの11キー完全一致、値漏洩なし | **PASS** |
| P2-7 guest expiry JST | 解決 | `a2f17b8` | HTTP応答がRFC 3339の明示`+09:00`になる回帰 | **PASS** |
| P2-8 壊れたJSONが500 | 解決 | `7b8e644` | 壊れたJSON、不正Content-Type、過大bodyを日本語`VALIDATION_FAILED`へ正規化するHTTP回帰 | **PASS** |
| P2-9 audit nested検査 | 解決 | **未commit（論理境界、unstaged/untracked）** | `audit.test.ts` 29 tests。runtime/Drizzle/raw SQLでtop/nested/array、case、camel/snake/kebab、学習内容・secretキー拒否とsafe metadata許可。`0003`/`0004`前方migration | **PASS（Task 8 fix round: 仕様適合/品質ともPASS）** |

Task 8の独立review fix roundはP2-3/P2-4/P2-6/P2-9について仕様適合・コード品質ともPASS。残余リスクは、実Google/GitHub資格情報による5シナリオ未実施と、audit event別allowlistをPhase 2のproduction write追加前に実装すること。

### P3 1〜3

| 指摘 | status | commit / 論理境界 | 主要テスト / 根拠 | 独立review |
| --- | --- | --- | --- | --- |
| P3-1 purge `--now` | 解決 | **未commit（論理境界、unstaged/untracked）** | 10 tests。未指定のみsystem clock、単一`+09:00`のみ受理、裸・空・重複・`Z`・他offset・offsetなし・不正時刻を安定`VALIDATION_FAILED`で拒否 | **PASS（Task 9 fix round）** |
| P3-2 DB test後処理 | 解決 | **未commit（論理境界、unstaged）** | 対象3実DB file / 24 tests。handle未初期化を型で表し、通常利用guard＋`afterAll` optional close。setup失敗時に二次`TypeError`なし | **PASS** |
| P3-3 Claude local設定 | 解決 | **未commit（論理境界、unstaged）** | `.claude/settings.local.json`だけをexact ignoreし、`.claude/README.md`等はignoreしない | **PASS** |

Task 9の最新fix roundは仕様適合・コード品質ともPASS、未解決findingなし。`createTestDatabase()`内部でhandle作成後にmigrationが失敗した場合のclose保証は、今回差分が新設した問題ではない残余リスクとして継続する。

### fresh再検証（2026-08-02）

専用PostgreSQL `127.0.0.1:55432/tango_test`がhealthyな状態で実行した。

| コマンド | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | exit 0、217 installs / 336 packages、変更なし |
| `bun run check` | exit 0、Biome 64 files、4 workspace typecheck、**17 test files / 165 tests pass** |
| `bun run build` | exit 0、全workspace成功（API 768 modules / 2.49 MB、Web 190.47 kB / gzip 60.07 kB） |
| `bun run db:auth-schema:check` | exit 0、`auth@1.6.25`生成結果とTIMESTAMPTZ変換に一致 |
| `bun run db:migrate` | exit 0、専用DBで`migrations applied successfully` |

migration実ファイルは`0000_identity.sql`〜`0004_cute_star_brand.sql`の5本。journalは`idx: 0..4`、snapshotの`prevId`鎖は0000→0004まで整合する。`0002`の`ALTER COLUMN`と生成schemaの`withTimezone: true`はいずれも12列。

### 再レビュー受付条件の充足状況

| 条件 | 状態 | 根拠 / 残件 |
| --- | --- | --- |
| P1全修正＋競合/データ喪失の実DB/HTTP回帰 | **充足** | P1-1〜7を個別commit、回帰追加、独立review PASS |
| P2解消または仕様変更承認 | **自動検証範囲は充足** | P2-1〜9の実装・自動test・独立reviewはPASS。P2-3の実provider手動5シナリオは未実施 |
| install / migration / check / build / auth schema check | **充足** | 上記freshコマンドがすべてexit 0 |
| 実OAuth結果、commit範囲、migration差分、既知制限をpacketへ反映 | **一部未充足** | commit済み範囲・未commit論理境界・migration・既知制限は更新済み。実OAuth 5シナリオの結果だけ未実施。Task 8/9/10のcommitも許可待ち |
| Phase 2未着手 | **充足** | Phase 1修正と文書更新以外へ進んでいない |

### 現在の判定

- P1 1〜7、P2 1〜9の自動検証範囲、P3 1〜3は修正済みで、各独立reviewはPASS。
- P2-3は自動provider mock境界までPASSだが、実Google/GitHub OAuth 5シナリオは未実施。自動テストを実OAuthとは扱わない。
- Task 8/9/10はcommit許可待ち。commit/pushは実行していない。
- Phase 2は未着手。実OAuth手動確認と未commit境界を残したまま、Codexの再レビュー判定を待つ。

---

## 2026-08-05 最終ハードニング（Task 1〜4）解決状況とレビュー体制変更

Phase 1全体レビューのImportant 6件（別途作成したローカル全体レビュー記録`.superpowers/sdd/phase-1-codex-review/final-review.md`のI-1〜I-6、`.superpowers/`はgitignore対象でありcommit対象外）を解消する「最終ハードニング」計画（`docs/superpowers/plans/2026-08-02-tango-phase-1-final-hardening.md`、設計: `docs/superpowers/specs/2026-08-02-tango-phase-1-final-hardening-design.md`）のTask 1〜4を実装した。I-1（Better Auth ID token非暗号化）、I-2（mergeKey replayのsource未binding）、I-3（provider identity一意制約なし）はTask 1・Task 2で、I-4（destructive test helperの接続先未binding）はTask 3で、I-5（redaction迂回経路）はTask 1・Task 4で、I-6（purge CLIの未知引数無視）はTask 4で解決した。詳細な対応関係と実装内容は`docs/reviews/phase-1-review.md`5章「Important I-1〜I-6の解決根拠」に記載した。

**レビュー体制の変更:** 従来の親方レビュアーであったCodexが利用制限に到達したため、Task 1〜3の独立レビューはClaudeが統括し、タスクごとに別々のSub-agentへ分離して実施した（`.superpowers/sdd/phase-1-codex-review/hardening-task-1-review.md`、`hardening-task-2-review.md`、および同等のTask 3検証記録。いずれもローカル作業ファイルでありcommit対象外）。結果はTask 1: 初回Important 1件検出→修正後PASS、Task 2: 初回Important 1件検出（`dumpIdentityText`が`source_guest_token_hash`を集約せず、統合テストが`merged`経路を検証していなかった）→修正後PASS、Task 3: PASS（Critical/Important/Minor該当なし）。Task 4には同形式の独立レビュー記録はない。実Google/GitHub OAuth以外の自動ゲート（`bun install --frozen-lockfile`、`bun run check`、`bun run build`、`bun run db:auth-schema:check`、`bun run db:generate`、`bun run db:migrate`）は2026-08-05にすべてfresh再実行し、成功を確認した（`bun run check`は19 files / 220 tests pass）。

Task 1〜4の変更は、従来から未commitだったTask 8/9/10相当の変更と同じworking tree上に重なっており、現時点ですべて未commit。Phase 2には引き続き未着手。実Google/GitHub OAuth 5シナリオの手動実施は未実施のまま残る。
