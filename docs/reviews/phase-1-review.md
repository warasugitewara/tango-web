# Phase 1 レビューパケット: 基盤と識別

- 更新日: 2026-08-05
- 対象ブランチ: `feat/phase-1-foundation-identity`
- commit済み対象範囲: `main` (`314264f`) から HEAD (`f26104c`) まで
- 最終ハードニングのcommit: `f26104c` `fix: Phase 1レビュー指摘を一括解消する`（47ファイル）。Phase 1全体レビューのImportant 6件を解消する「最終ハードニング」Task 1〜4、および従来から未commitだったTask 8/9/10相当の変更を、計画どおり単一commitへまとめた（下表参照）
- 計画: `docs/superpowers/plans/2026-08-01-tango-01-foundation-identity.md`（初回実装）、`docs/superpowers/plans/2026-08-02-tango-phase-1-final-hardening.md`（今回の最終ハードニング、Task 1〜5）
- 仕様: `docs/superpowers/specs/2026-08-01-tango-spaced-repetition-design.md`（初回設計）、`docs/superpowers/specs/2026-08-02-tango-phase-1-final-hardening-design.md`（今回のハードニング設計、§1〜§4）
- 状態: Phase 2未着手、pushなし、Codexが利用制限に到達したため今回のTask 1〜3独立レビューはClaudeが統括しタスクごとに別Sub-agentで実施（詳細は`docs/reviews/phase-1-codex-review.md`追記部）。差分は`f26104c`としてcommit済みで、pushはしていない

レビュー観点（計画 Task 6 Step 7、および最終ハードニング計画 Task 5 Step 2）: 仕様適合、識別処理の競合、Cookieとトークンの取り扱い、Better Auth設定、migration、テスト証跡、env/maintenance jobのfail-closed境界。

## 1. 対象範囲とcommit map

### commit済み

| 区分 | commit | Git subject | 対応 |
| --- | --- | --- | --- |
| 設計 | `e2837d3` | `docs: Tango設計と段階別実装計画を追加` | 仕様と4フェーズ計画の基準 |
| Task 1 | `36efcda` | `chore: Bunワークスペースと品質ゲートを初期化` | Bun workspaceと品質gate |
| Task 2 | `080e522` | `feat: JST学習日と共通エラー契約を追加` | JST学習日と共通契約 |
| Task 3 | `9762d83` | `feat: 認証主体とゲストセッションのDB基盤を追加` | identity DB基盤 |
| Task 4 | `ca593cf` | `feat: 安全なゲスト認証と期限管理を追加` | guest認証と期限管理 |
| Task 5 | `28d4831` | `feat: GoogleとGitHubの正式アカウント連携を追加` | Better Authと正式account連携 |
| Task 6 | `a70584f` | `test: 認証基盤の統合検証とレビュー資料を追加` | 統合検証と初回review packet |
| P1-2 | `d12206a` | `fix: 一時障害でゲストCookieを削除しないようにする` | 一時障害時のゲストCookie保持 |
| P1-3 | `b3702c0` | `fix: ゲスト期限の延長時にCookieも再発行する` | ゲスト期限延長時のCookie再発行 |
| P1-1 | `463eb20` | `fix: 既存ゲストのCookieを上書きしないようにする` | 既存ゲストのCookie上書き防止 |
| P1-4 | `b676fbb` | `fix: 識別完了で対象行をロックし並行昇格の上書きを防ぐ` | 識別完了の行ロックと並行昇格防止 |
| P1-5 | `83cb66b` | `fix: 統合後に取り込み元のゲストprincipalを削除する` | 統合元guest principalのtransaction内削除 |
| P1-6 | `4c3d3f9` | `fix: 期限切れゲストの掃除を単一トランザクションで行う` | purgeのtransaction化、`FOR UPDATE SKIP LOCKED`、削除条件再確認 |
| P1-7 | `c774a8b` | `fix: テストDB接続先がテスト専用かを破壊操作の前に検証する` | 破壊操作前のテスト専用DB URL検証 |
| P2-1 | `bc84fa0` | `fix: エラーログに生のstackとメッセージを残さない` | 生stack/messageを残さないエラーログ |
| P2-8 | `7b8e644` | `fix: 壊れたボディを500ではなくVALIDATION_FAILEDへ正規化する` | 壊れたJSON・Content-Type・過大bodyの正規化 |
| P2-2 | `0156756` | `fix: 本番のオリジンを固定しSecure Cookieの取りこぼしを防ぐ` | production origin固定とSecure Cookie強制 |
| P2-7 | `a2f17b8` | `fix: ゲスト期限のレスポンスをJST形式で返す` | ゲスト期限の明示`+09:00`形式 |
| P2-5 | `b08ba5b` | `fix: 識別完了の冪等性キーと応答契約を計画へ揃える` | UUIDv7冪等性キー、所有者検証、`actor`/`outcome`応答契約 |

再現コマンド:

```powershell
git log --oneline 314264f..HEAD
git diff --stat 314264f..HEAD
```

### 未commitの論理境界

下表の論理境界はすべて`f26104c`という単一commitに含まれる。区分ごとの個別commitは存在しないため、区分単位のSHAを捏造しない。2026-08-02時点でP2-3/P2-4/P2-6/P2-9/P3-1/P3-2/P3-3/Task 10として個別に記載していた論理境界は、いずれも一度もcommitされないまま今回の最終ハードニングTask 1〜4と同じ working tree 上で重ね書きされ、境界が実質的に一体化した。したがって本改訂では、2026-08-02〜08-05に実施した最終ハードニング計画のTask単位で論理境界を書き直す。全体はTask 5完了後に**単一の日本語Conventional Commit** `f26104c` `fix: Phase 1レビュー指摘を一括解消する` へまとめた。下表の「状態」列はこのcommitへ入る直前のworking tree上の状態を記録したものである。

| 区分 | 状態 | 主な変更（対応する旧区分） |
| --- | --- | --- |
| Task 1 | **未commit（論理境界、`better-auth.ts`と`oauth-callback.integration.test.ts`のみ一部stage済み、残りunstaged/untracked）** | Better Auth `idToken`非永続化、safe logger、`(provider_id, account_id)`複合unique index、`0005_colorful_kingpin.sql`。旧P2-3・P2-4の一部を包含 |
| Task 2 | **未commit（論理境界、unstaged/untracked）** | `identity_merges.source_guest_token_hash`によるmergeKey replayのsource binding、`0006_hot_gertrude_yorkes.sql` |
| Task 3 | **未commit（論理境界、unstaged）** | `TestDatabaseHandle`のruntime brand化と`resetIdentityTables`のhandle限定。旧P3-2を包含 |
| Task 4 | **未commit（論理境界、unstaged/untracked）** | `DATABASE_URL`のURL/protocol検証、purge CLIの閉じたargv検査、purge top-levelログの安全化。旧P3-1を包含 |
| 計画外対応 | **未commit（論理境界、untracked）** | `toSafeErrorName`を`packages/shared/src/errors/safe-error-name.ts`へ一本化（詳細は8章の逸脱表） |
| 旧P2-6/P3-3相当 | **未commit（論理境界、unstaged）** | `.env.example`とruntime schemaの11キー一致、`.gitignore`の限定ignoreは維持されたまま今回も未commit |
| 旧P2-9相当 | **未commit（論理境界、unstaged/untracked）** | audit metadataのruntime/DB再帰・大小文字・秘密キー防御、`0003`/`0004`は今回も未commitのまま |
| Task 5 | **未commit（論理境界、unstaged/untracked）** | 本レビューpacketと`phase-1-codex-review.md`追記、独立review実施記録 |

`git status --porcelain=v1 -uall` で2026-08-05に再確認した現在の構成:

- stage済み（index）: `apps/api/src/app.ts`（M）、`apps/api/src/features/auth/better-auth.ts`（indexとworking treeの双方に差分あり=MM）、`apps/api/src/features/auth/oauth-callback.integration.test.ts`（indexはadd、working treeにも追加差分=AM）、`apps/api/src/features/auth/oauth-error-page.ts`（A）
- working tree差分あり（tracked、unstaged）: 上記4件のうち`better-auth.ts`と`oauth-callback.integration.test.ts`を含め、`.env.example`、`.gitignore`、`apps/api/src/env.ts`／`env.test.ts`、`apps/api/src/features/auth/identity-completion-service.test.ts`、`identity-flow.integration.test.ts`、`provider-routes.test.ts`、`apps/api/src/jobs/purge-expired-guests.ts`、`apps/api/src/middleware/error-handler.ts`、`docs/reviews/phase-1-review.md`（本ファイル）、`package.json`、`packages/db/migrations/meta/_journal.json`、`packages/db/scripts/check-auth-schema.ts`、`packages/db/src/repositories/principal-repository.ts`／`.test.ts`、`packages/db/src/schema/audit.ts`、`auth.generated.ts`、`principals.ts`、`packages/db/src/test/database.ts`／`.test.ts`、`packages/shared/src/index.ts`
- untracked: `apps/api/src/jobs/purge-expired-guests.test.ts`、`docs/reviews/phase-1-codex-review.md`、`docs/superpowers/plans/2026-08-02-tango-phase-1-final-hardening.md`、`docs/superpowers/specs/2026-08-02-tango-phase-1-final-hardening-design.md`、`packages/db/migrations/0002_hard_donald_blake.sql`〜`0006_hot_gertrude_yorkes.sql`とその`meta/`snapshot、`packages/db/scripts/auth-schema.ts`／`.test.ts`／`generate-auth-schema.ts`、`packages/db/src/schema/account-identity.test.ts`／`audit.test.ts`／`auth-instant-migrations.test.ts`、`packages/shared/src/errors/safe-error-name.ts`／`.test.ts`

commit/push実行前に、この一覧と`.gitignore`を再度突き合わせ、`.superpowers/`と`.claude/settings.local.json`を混入させないことを最終確認する。

## 2. migration

実ファイルは`0000`〜`0006`の7本。`meta/_journal.json`は`idx: 0..6`の7 entryで、`0000_snapshot.json`から`0006_snapshot.json`までの`id` / `prevId`が連続している。`0000`〜`0004`は今回のハードニングで変更していない。

| migration | 状態と目的 |
| --- | --- |
| `0000_identity.sql` | 9テーブル（`account`, `audit_logs`, `guest_sessions`, `identity_merges`, `principals`, `session`, `user`, `user_settings`, `verification`）を作成 |
| `0001_identity_merge_key_uuid.sql` | `identity_merges.merge_key`を`text`から`uuid`へ前方変換 |
| `0002_hard_donald_blake.sql` | Better Authのinstant 12列を`timestamp with time zone`へ前方変換。旧naive UTC壁時計の意味を`AT TIME ZONE 'UTC'`で保持 |
| `0003_daily_cable.sql` | `audit_logs.metadata`の学習内容キーを全階層で拒否する再帰CHECKへ前方更新 |
| `0004_cute_star_brand.sql` | 0003のCHECKを、ASCII大小文字を小文字化し`_`/`-`を除去する規則と秘密値キー集合へ前方更新 |
| `0005_colorful_kingpin.sql`（新規） | `account`へ`(provider_id, account_id)`の複合unique indexを前方追加（Important I-3対応）。既存重複行の自動削除はしない。fail closedのため既存重複がある環境では適用が停止する |
| `0006_hot_gertrude_yorkes.sql`（新規） | `identity_merges.source_guest_token_hash`（nullable `text`）を追加（Important I-2対応）。既存記録は推測backfillせずnullのまま |

Better Authの生成SoTは直接手編集しない。pinned `auth@1.6.25` CLIの出力へ決定的な生成後変換を適用し、`auth.generated.ts`の12列すべてを`withTimezone: true`にし、かつ`uniqueIndex(providerId, accountId)`を1件だけ挿入する。TIMESTAMPTZ対象が12列ちょうど、unique indexが1件ちょうどでなければfail closedする。`bun run db:auth-schema:check`はCLI生成結果＋変換結果との一致を検査する。

自前テーブルを含むすべてのinstant列も`TIMESTAMPTZ`であり、接続時は`TimeZone = Asia/Tokyo`を設定する。以前の「生成auth列はtimestamp without time zone」という差分は解消済み。

2026-08-05のfresh検証では、空DB（`tango_fresh_test`を新規作成）に対して`0000`〜`0006`をクリーンに適用できることと、既存の適用済みDBに対しても`bun run db:migrate`がexit 0で完了することの両方を確認した。既存provider重複や既存audit禁止行の自動削除・自動redactは行っていないため、本番適用前には`0005`/`0004`相当のread-only preflight（重複件数確認、禁止key含有行確認）を手動gateとして残す。

### audit metadata防御

- runtime: `assertAuditMetadata`がobject/arrayを循環安全に再帰走査し、通常のDrizzle writeではcustom JSONB `toDriver`から必ず検証する。
- DB: JSONPathで全階層object keyを検査し、raw SQL等のruntime迂回にもCHECKを適用する。
- 共通規則: ASCII大小文字を同一視し、ASCIIの`_`と`-`だけを除去してから、キー全体を禁止集合と比較する。space、dot、非ASCIIは同一視しない。
- 禁止集合: 学習内容キーに加え、token/session/cookie/password/secret/OAuth credential等の秘密値キーを一つのSoTで管理する。
- 限界: 汎用denylistは無害な別名キーへの誤格納を完全には検知できない。Phase 2でproduction audit write eventを追加する前にevent別allowlist schemaを必須化する。

## 3. fresh検証結果（2026-08-05）

Windows 11、Bun 1.3.14、専用PostgreSQL `127.0.0.1:55432`で実行した。

| コマンド | fresh結果 |
| --- | --- |
| `bun install --frozen-lockfile` | exit 0、217 installs / 336 packages、変更なし |
| `bun run check` | exit 0、Biome **67 files**修正なし、4 workspace typecheck exit 0、Vitest **19 files / 220 tests pass** |
| `bun run build` | exit 0、全workspace成功。API 769 modules / 2.49 MB、Web 190.47 kB（gzip 60.07 kB） |
| `bun run db:auth-schema:check` | exit 0、`auth@1.6.25`生成結果とTIMESTAMPTZ変換・複合unique indexに一致 |
| `bun run db:generate` | exit 0、`No schema changes, nothing to migrate` |
| `bun run db:migrate` | exit 0。**空DB`tango_fresh_test`を新規作成して`0000`〜`0006`を適用しクリーンに成功**。既存の適用済みDBに対しても exit 0 |

テスト一覧は`bunx vitest list`をファイル別に集計し、上記fresh runの総数と一致させた。

| テストファイル | 件数 |
| --- | ---: |
| `packages/db/src/schema/audit.test.ts` | 29 |
| `apps/api/src/jobs/purge-expired-guests.test.ts` | 24 |
| `apps/api/src/features/auth/auth-routes.test.ts` | 23 |
| `apps/api/src/features/auth/provider-routes.test.ts` | 22 |
| `apps/api/src/env.test.ts` | 17 |
| `packages/db/src/repositories/principal-repository.test.ts` | 16 |
| `packages/shared/src/errors/app-error.test.ts` | 15 |
| `packages/db/src/test/database.test.ts` | 12 |
| `packages/shared/src/time/learning-day.test.ts` | 11 |
| `apps/api/src/features/auth/guest-service.test.ts` | 10 |
| `packages/shared/src/errors/safe-error-name.test.ts` | 9 |
| `apps/api/src/features/auth/identity-flow.integration.test.ts` | 8 |
| `packages/db/scripts/auth-schema.test.ts` | 6 |
| `apps/api/src/features/auth/identity-completion-service.test.ts` | 6 |
| `apps/api/src/middleware/error-handler.test.ts` | 5 |
| `packages/db/src/schema/auth-instant-migrations.test.ts` | 2 |
| `packages/db/src/schema/account-identity.test.ts` | 2 |
| `apps/api/src/features/auth/oauth-callback.integration.test.ts` | 2 |
| `tests/config/workspace.test.ts` | 1 |
| **合計** | **220** |

165件（2026-08-02時点）から220件への増加55件は、今回のTask 1〜4回帰（provider identity一意性、mergeKeyのsource binding、`TestDatabaseHandle`拒否matrix、env/purge argv fail-closed、`toSafeErrorName`単体test）と、それに伴う既存ファイルへのcase追加による。

実DBを使うテストは、repository/identity completion/identity flowに加え、OAuth callback、audit、auth instant migrationを含む。DB URLは接続前と`TRUNCATE`前に、PostgreSQL scheme、loopback host、`_test` suffix、非productionを検証することに加え、今回のTask 3で`TestDatabaseHandle`のruntime brand（module-private `unique symbol` + WeakMap identity）と`current_database()`一致も検証する。

## 4. OAuth確認

### 自動境界検証

`oauth-callback.integration.test.ts`は、実Better Auth 1.6.25 callback、実PostgreSQL adapter、Google token endpoint mockを通し、既存GitHub利用者と同じemailのGoogle callbackが暗黙linkされず、`account_not_linked`が同一originの`/auth/error`へredirectされ、`ACCOUNT_NOT_LINKED`と日本語回復案内に写像されることを検証する。これは**自動provider mock境界テストであり、実OAuthではない**。

今回のTask 1（Step 1）で、同ファイルへ成功callback経路のテストを追加した。provider mock＋実PostgreSQL adapterを通し、正式session Cookieの`Secure; HttpOnly; SameSite=Lax; Path=/`（`Domain`なし）属性、DBに保存されたaccess/refresh tokenの暗号文がrawと異なること、`id_token`列がnullであることを検証する。これは`.superpowers/sdd/phase-1-codex-review/final-review.md`のMinor M-3（実際の成功OAuth callback/Cookie/token保存経路が自動テストされていない）の解消に相当するが、依然として**provider mockであり実OAuthプロバイダとの通信ではない**。

### 実Google/GitHub OAuth 5シナリオ（未実施）

実在providerの資格情報と対話ブラウザがないため、計画 Task 6 Step 4は未実施のまま。

| # | シナリオ | 状態 |
| --- | --- | --- |
| 1 | 新規Googleログインが`/auth/complete`へ到達し正式principalを作る | 未実施 |
| 2 | Googleログイン済み利用者がGitHubを明示連携する | 未実施 |
| 3 | Googleが残る場合だけGitHub連携解除が成功する | 未実施 |
| 4 | same-email未連携providerのsign-inで日本語回復案内が出る | 未実施 |
| 5 | ゲストprincipalが昇格/統合され、成功後だけゲストCookieが消える | 未実施 |

したがってP2-3の自動境界はPASSだが、リリース前の手動実OAuth確認は残る。

## 5. 修正後のセキュリティ・契約状態

### Important I-1〜I-6の解決根拠

2026-08-01の初回Codexレビュー（`docs/reviews/phase-1-codex-review.md`）はP1/P2/P3という番号体系を使っており、「Important I-1〜I-6」という番号はそこには存在しない。この番号は、2026-08-02にPhase 1全体worktree（初回実装＋Task 8/9/10相当の未commit差分）を対象に行った別の全体レビュー記録`.superpowers/sdd/phase-1-codex-review/final-review.md`（ローカル作業ファイル。`.superpowers/`は`.gitignore`対象でありcommit対象外）で初出する。今回の最終ハードニング計画・設計書（`docs/superpowers/plans/2026-08-02-tango-phase-1-final-hardening.md`、`docs/superpowers/specs/2026-08-02-tango-phase-1-final-hardening-design.md`）はこの6件を「Important 6件」として引き継ぎ、設計書§1〜§4として再整理した。本節はfinal-review.mdのI-1〜I-6番号と設計書の§区分の両方で対応付ける。commit対象に含まれないローカルファイルへの参照である点に留意する。

| Important | 指摘概要（要約） | 設計書区分 | 解決したTask / 根拠 |
| --- | --- | --- | --- |
| I-1 | `encryptOAuthTokens: true`を設定してもBetter Auth 1.6.25はcreate/update/link時の`idToken`をrawのままadapterへ渡し、暗号化されない | §1 | Task 1: `databaseHooks.account.create.before`/`update.before`で`idToken`を`null`へ置換し永続化しない。成功callback統合testでaccess/refresh tokenのciphertext非同一と`id_token is null`を検証。独立review: 初回Important 1件（同一provider update時のtoken assertionの弱さ）を検出しfix round再reviewでCritical/Important/Minor 0件のPASSに到達 |
| I-2 | 記録済み`mergeKey`のreplay判定が`target userId`だけで、`identity_merges.source_principal_id`はmerge後のguest削除で`ON DELETE SET NULL`になるため、別の有効guest Cookieを伴う再送でそのguestデータを保護できないままCookieだけ消える | §2 | Task 2: `identity_merges.source_guest_token_hash`（`0006_hot_gertrude_yorkes.sql`）を追加し、`userId`と`source_guest_token_hash`の両方が一致する場合だけ`existing`を返す。不一致は`CONFLICT`でguest Cookieを保持。独立review: Important 1件（`dumpIdentityText`が新列を集約せず、統合テストが`promoted`経路のみを通っていた）を検出し修正、fix round再reviewでCritical/Important/Minor 0件のPASS |
| I-3 | `account`テーブルに`(provider_id, account_id)`のDB一意制約がなく、同一provider identityを2ユーザーへ並行linkすると重複行が成立し得る | §1 | Task 1: 生成後変換へ`uniqueIndex(providerId, accountId)`を追加し、`0005_colorful_kingpin.sql`で前方migrationする。異なるuserからの並行insertで一方だけ成功するDB統合testを追加 |
| I-4 | `resetIdentityTables(db)`がglobal `TEST_DATABASE_URL`は検証するが、実際にTRUNCATEする`Database`は呼出側が自由に渡せる契約になっており、安全なURL検証と破壊対象が結び付いていない | §3 | Task 3: `createTestDatabase()`だけが生成できるruntime brand付き`TestDatabaseHandle`を導入し、`resetIdentityTables()`はhandle全体だけを受け取る。brand（module-private `unique symbol` + WeakMap identity）→`_test`接尾辞→`select current_database()`一致の三段検査をTRUNCATE前に行う。独立review: Critical/Important/Minor 0件のPASS |
| I-5 | `DATABASE_URL`は非空文字列としてしか検証されず不正入力がそのままログに出る、purge jobがtop-levelで`error.message`を生ログする、Better Authに custom loggerを設定していないため既定loggerがraw argsを`console.error`する | §1, §4 | Task 1（Better Auth custom logger: library由来のmessage/argsを捨て`{ component, level, errorId }`だけを記録）とTask 4（`DATABASE_URL`をURLとして解釈しprotocolが`postgres:`/`postgresql:`の場合だけ受理、エラーにはキー名だけを出す。purge top-level error logは生message・cause・stackを捨て`job`/`level`/`errorId`(uuidv7)/安全な`errorName`だけを記録）で解決。加えて計画外対応として`toSafeErrorName`を`packages/shared`へ一本化し、`error-handler.ts`と`purge-expired-guests.ts`の重複実装を解消した（8章の逸脱表を参照） |
| I-6 | purge CLIのargv parserが`--now`だけをfilterし、それ以外の未知引数・typoを無条件でsystem clock扱いにする | §4 | Task 4: argv全体を閉じた集合として検査し、未知option、typo、位置引数、裸`--now`、空、重複、valid nowとの混在をすべて`VALIDATION_FAILED`で拒否する |

同final-review.mdはMinor M-1〜M-4も記録している。M-3（実際の成功OAuth callback/Cookie/token保存経路が自動テストされていない）はTask 1 Step 1で追加した成功callback統合testにより解消した（4章参照）。M-1（guest daily touchの非atomic更新）、M-2（test DB migration失敗時のconnection/promise後始末）、M-4（CI drift gateがBetter Auth生成schemaに限定され、domain schema全体のdrift検査がない）は今回のTask 1〜4のscope外であり、6章の「Phase 2以降へ残す事項」に引き続き記録する。

### 環境変数

runtime schemaと`.env.example`は次の11キーで完全一致する。

`APP_ENV`, `APP_ORIGIN`, `DATABASE_URL`, `GUEST_TOKEN_PEPPER_FILE`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_FILE`, `BETTER_AUTH_SECRET_FILE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET_FILE`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET_FILE`

秘密値は環境変数へ直接置かず、`*_SECRET_FILE` / `GUEST_TOKEN_PEPPER_FILE`のファイルから読む。env検証失敗はキー名だけを報告し、値を出さない。以前の「`.env.example`未解決」は解消済み。

### origin・Cookie・Better Auth

- productionは`APP_ORIGIN === 'https://tango.warasugi.com'`以外を起動前に拒否し、正式・ゲストCookieとも`Secure`を強制する。HTTPを許すのはローカルdevelopment/testだけ。
- Cookieは`HttpOnly`, `SameSite=Lax`, `Path=/`, Host-only（`Domain`なし）。ゲストは90日、正式sessionは30日rolling、更新間隔1日、fresh age 600秒。
- `basePath: '/api/auth'`, `trustedOrigins`は検証済み単一origin、Google/GitHubのみ、email/password無効、CSRF/origin check有効。
- OAuth access/refresh tokenは引き続き暗号化される。今回のTask 1で`databaseHooks.account.create.before`/`update.before`が`idToken`を`null`へ置換するため、Better Auth 1.6.25が暗号化しないID tokenはそもそもDBへ永続化されない（Important I-1対応）。
- Better Authのcustom loggerを設定し、libraryから渡されるmessage/argsを使わず`{ component: 'better-auth', level, errorId }`だけを構造化記録する（Important I-5の一部）。
- 生成後変換で`account`テーブルへ`uniqueIndex(providerId, accountId)`を追加し、`0005_colorful_kingpin.sql`で前方migrationする。同一provider identityへの並行insertはDB制約で一方だけ成功する（Important I-3対応）。
- 有効な既存ゲストで`/api/guest/start`を再実行しても新しいtoken/Cookieを発行しない。一時DB障害ではCookieを保持し、失効確定時だけ削除する。DB期限を延長した時だけ同じtokenのCookie期限も再発行する。

### error・request境界

- 未知例外の生stack/messageは記録しない。ログはrequest ID、内部error ID、安定code、status、method/path、安全な例外名・cause名・呼出位置だけに限定する。
- Cookie、request body、接続URL、SQL、カード内容をレスポンス/ログへ出さない。
- 壊れたJSON、Content-Type不正、過大bodyは日本語`VALIDATION_FAILED`へ正規化する。
- 今回、例外から安全なクラス名だけを取り出すsanitizer`toSafeErrorName`を`packages/shared/src/errors/safe-error-name.ts`へ一本化し、`apps/api/src/middleware/error-handler.ts`と`apps/api/src/jobs/purge-expired-guests.ts`の両方が同じ実装をimportする（計画外対応、8章参照）。挙動（判定順・正規表現・64文字切り詰め・フォールバック文字列）は変更していない。

### concurrency・identity・purge

- 識別完了はguest session → source principal → target principalの順で`FOR UPDATE`し、lock後に有効性・kind・userIdを再確認する。昇格UPDATEにもguest条件を残す。
- merge成功時はowned rows移送hook、merge記録、source principal削除を同一transactionで行う。Phase 1には移送対象のドメインrowがない。
- merge keyはUUIDv7/DB `uuid`で、再送時も記録済みtargetのuserId一致を必須にする。APIは正式`actor`と`outcome`を返す。
- 今回のTask 2で`identity_merges.source_guest_token_hash`（`0006_hot_gertrude_yorkes.sql`、nullable text）を追加し、記録済み`mergeKey`の再送は`target userId`と`source guest token hash`の両方が一致する場合だけ`existing`を返す。別guest、guest→なし、なし→guestの組み合わせはすべて`CONFLICT`とし、guest Cookieを削除しない（Important I-2対応）。
- purgeは単一transactionで`FOR UPDATE SKIP LOCKED`を使い、削除時にも有効session不在を再確認する。
- purgeの`--now`はtest modeの単一`--now=<RFC3339 +09:00>`だけを許可する。今回のTask 4でargv全体を閉じた集合として検査するよう強化し、裸・空・重複・他offset・未知option・位置引数・valid nowとの混在をすべて`VALIDATION_FAILED`で拒否する（Important I-6対応）。

### 破壊的test helperの接続先binding（Task 3、Important I-4対応）

- `createTestDatabase()`だけが生成できる非公開runtime brand付き`TestDatabaseHandle`を導入した。module-private `unique symbol`をrequired propertyとして持ち、module-private `WeakMap<object, string>`へfactoryが返したobject identityと検証済みDB名だけを登録する。接続URL・username・passwordはhandle property・エラーへ保持しない。
- `resetIdentityTables()`はこのhandle全体だけを受け取り、TRUNCATE前にbrand（identity）→期待DB名の`_test`接尾辞→実接続先の`select current_database()`完全一致、の三段検査を行う。
- `Reflect.apply`によるforeign object偽装、およびsymbol propertyだけをshallow copyした偽装ハンドルの両方を、実測でTRUNCATE前に固定エラーとして拒否することを確認した。
- 通常のDB query用`.db`はfreezeしないため、既存テストの通常利用には影響しない。破壊操作前後の接続先はloopback host、`tango_test`（または`_test`接尾辞の一時DB）であることを確認済み。

## 6. Phase 2以降へ残す事項

- Phase 2は未着手。デッキ、カード、レビュー等のドメインテーブルはまだない。
- `moveOwnedDomainRows`はPhase 2で移送対象を追加する拡張点。ドメインwrite時の所有権再検証・lock protocolを守る。
- production audit write経路はまだない。追加前にevent別allowlist schemaを実装する（denylistだけを安全境界にしない）。
- `apps/web`は雛形で、`/auth/complete`等の製品画面は後続フェーズ。
- アカウント削除はPhase 4のfresh OAuth確認フローまで無効。
- 汎用rate limitは後続フェーズ。Phase 1はゲスト開始のTurnstileのみ。application CSRF、security headersと合わせてPhase 4のmandatory release gate。
- 実Google/GitHub OAuth 5シナリオはリリース前に手動実施する（4章参照、未実施）。
- Minor findings（`.superpowers/sdd/phase-1-codex-review/final-review.md`のM-1〜M-4のうちM-3以外）は今回未解決のままPhase 2開始を妨げない追跡事項として残す。
  - M-1: guest daily touchが観測値・day境界をWHEREへ含まないCAS更新になっておらず、遅い並行requestが新しい値を上書きし得る（データ喪失ではなく軽微な有効期限短縮）。
  - M-2: `createTestDatabase()`のmigration失敗時にconnection close・rejected promise cacheの後始末がなく、後続suiteの原因切り分けを悪化させ得る。
  - M-4: CI drift gateは`bun run db:auth-schema:check`によるBetter Auth生成schemaのdrift検査に限定され、domain schema全体の「未生成migration差分なし」を検査するCI commandがない。
  - M-3（成功OAuth callback/Cookie/token保存経路の自動test不足）はTask 1 Step 1で解消済み（4章参照）。

初回リリースの仕様上の除外（Anki `.apkg`、cloze、メディア、PWA/オフライン同期、FSRS個人最適化、非空accountへの学習履歴restore、email/password、Discord OAuth等）も変更しない。

## 7. Phase 2が依存するinterface

### `Actor` / `ServiceContext`

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

所有者は常に`principalId`で表す。`ServiceContext`は`requireServiceContext(context)`経由で取得する。

### DB / repository

`DatabaseTransaction`はDrizzleの`Database['transaction']` callback引数から導出する。`PrincipalRepository`はguest作成・解決・touch・revoke・purgeと、`completeIdentity`の`created | promoted | merged | existing`を提供する。Phase 2は次のhookだけを同一transaction内で拡張する。

```ts
export async function moveOwnedDomainRows(
  sourcePrincipalId: string,
  targetPrincipalId: string,
  tx: DatabaseTransaction,
): Promise<void>
```

## 8. 計画からの逸脱（最終実装）

| # | 内容 | 理由 / 現在の扱い |
| --- | --- | --- |
| 1 | Better Auth CLIは`@better-auth/cli@1.6.25`ではなく`auth@1.6.25` | 前者の対象版がnpmに存在せず、後者が同版のCLIを提供するため |
| 2 | Better Auth生成結果へ決定的なTIMESTAMPTZ変換を追加 | 生成物の直接編集禁止と仕様の全instant TIMESTAMPTZを両立。`0002`で既存DBも前方移行 |
| 3 | audit CHECKを`0003`、独立review修正を`0004`として追加 | 適用済みmigrationを書き換えず、再帰・case・secret防御を前方更新するため |
| 4 | `biome.json`で生成物とmigrationを除外 | formatterが生成driftやSQLを変更しないため |
| 5 | `better-auth.config.ts`をschema生成用にenv非依存化 | 生成に接続情報・secretを要求しないため。runtime入口は`better-auth.ts`のみ |
| 6 | repositoryに`purgeExpiredGuests` / `moveOwnedDomainRows`を追加 | maintenance commandとPhase 2の原子的移送hookに必要 |
| 7 | root Vitestを`fileParallelism: false`に設定 | 単一実DBを共有するテスト同士の`TRUNCATE`競合を防ぐため |
| 8 | `@tango/db`のtest subpathとDB検証helperを追加 | API統合テストと秘密値非保存検査を依存追加なしで行うため |
| 9 | `README.md`を新規作成 | 元ファイルが存在しなかったため |
| 10 | JSON body guard、OAuth error page、audit/auth migration検証を追加 | Codexレビューで判明したHTTP・OAuth・schema境界を回帰可能にするため |
| 11 | `toSafeErrorName`（例外から安全なクラス名だけを取り出すログsanitizer）を`packages/shared/src/errors/safe-error-name.ts`へ単一のSoTとして統合し、`apps/api/src/middleware/error-handler.ts`と`apps/api/src/jobs/purge-expired-guests.ts`をimportへ置き換えた | 最終ハードニング計画のTask 4ファイル範囲（`env.ts`/`env.test.ts`/`purge-expired-guests.ts`/`.test.ts`）を超える対応。security-relevantなsanitizerを2箇所に重複実装すると片方だけ修正されログ漏洩経路が生まれるため、単体test（`packages/shared/src/errors/safe-error-name.test.ts`）を追加した上で一本化した。判定順・正規表現・64文字切り詰め・フォールバック文字列の挙動は変更していない |

古い逸脱記載の「生成authのTIMESTAMPTZ差分」「`.env.example`未解決」「auditはtop-level CHECKのみ」は解消済み。

## 9. 再レビュー時の残件

1. 実Google/GitHub OAuth 5シナリオは未実施。実資格情報と対話ブラウザが必要であり、provider mock境界テスト（Task 1の成功callback testを含む）を実OAuthの代替完了とは扱わない。
2. 最終ハードニングTask 1〜4、および従来から未commitだったTask 8/9/10相当の変更は、計画どおり1件の日本語Conventional Commit `f26104c` `fix: Phase 1レビュー指摘を一括解消する`（47ファイル）へまとめた。1章の論理境界表を参照。本節のこの記述だけは`f26104c`の後続commitで追記している。
3. pushしていないため、GitHub CIは最新worktree差分では未実行。
4. application CSRF、security headers、汎用rate limitはPhase 4のmandatory release gate。Phase 2のaudit writerを追加する前にevent別allowlist schemaを必須化する。
5. Minor findings（guest touch CAS = M-1、test migration failure recovery = M-2、domain schema drift CI = M-4）はPhase 2開始を妨げない追跡事項として残る（6章参照）。
6. 今回のレビュー体制の変更: 従来の親方レビュアーであったCodexが利用制限に到達したため、Task 1〜3の独立レビューはClaudeが統括し、タスクごとに別のSub-agentへ分離して実施した（Task 1: PASS。Task 2: Important 1件を検出し修正後にPASS。Task 3: PASS）。Task 4には同形式の独立レビュー記録はない。計画 Task 5 Step 4 の「base `314264f`からworktree全体をfresh reviewerへ渡す最終ブランチレビュー」は、利用制限を優先して**未実施**であり、Task 1〜3の独立レビュー3件と禁止パターンの機械走査（`any`/`@ts-ignore`/広い型assertion/非nullアサーション/secret/stage scope、いずれもヒットなし）で代替した。実OAuth以外の自動ゲート（`bun install`、`bun run check`、`bun run build`、`db:auth-schema:check`、`db:generate`、`db:migrate`）はすべて2026-08-05にfresh再実行済み。
7. Phase 2には進まず、上記commitとGitHub CI実行後の再レビュー判定を待つ。
