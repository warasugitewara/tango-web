# Tango Phase 1 最終ハードニング設計

## 目的

Phase 1全体レビューで確定したImportant 6件を、依存関係を更新せず、既存のPhase 1契約と前方migration方針を維持したまま解消する。Phase 2のドメイン機能、Phase 4所有のCSRF・security header・rate limitへは着手しない。

## 1. Better Authの保存・ログ境界

- Better Auth 1.6.25は`encryptOAuthTokens: true`でもID tokenを暗号化しないため、`databaseHooks.account.create/update.before`で`idToken`を`null`へ置換し、永続化しない。access/refresh tokenの既存暗号化は維持する。
- Better Authのcustom loggerはlibraryから渡されるmessage・例外argsを捨て、component、level、生成した内部error IDだけを構造化記録する。provider response、token、URL、stackを記録しない。
- Better Auth生成schemaの決定的変換へ`uniqueIndex(providerId, accountId)`を加える。生成後変換はTIMESTAMPTZ対象12列と複合unique indexを完全一致で検証し、部分変換をfail closedにする。
- 成功OAuth callbackをprovider mock＋実PostgreSQL adapterで通し、正式session Cookie属性、access/refresh tokenの非平文、ID token非保存を確認する。別userから同じprovider identityを並行insertした場合はDB制約で一方だけ成功させる。

## 2. identity完了のsource binding

- `identity_merges`へ`source_guest_token_hash`を追加する。値は既存guest Cookieから生成済みのHMAC-SHA-256 hashであり、生tokenではない。
- merge記録には入力`guestTokenHash`を保存し、記録済み`mergeKey`の再送は`target userId`と`source_guest_token_hash`の両方が一致する場合だけ`existing`を返す。
- 同一keyを別guest、guestなしからguest、guestからguestなしで再利用した場合は`CONFLICT`とし、routeはguest Cookieを削除しない。同一key・同一sourceのresponse-loss retryは従来どおり収束する。

## 3. destructive test helperの接続先binding

- `createTestDatabase()`だけが生成できる非公開runtime brand付き`TestDatabaseHandle`を導入し、`resetIdentityTables()`はこのhandle全体だけを受け取る。
- handleには検証済みDB名だけを保持し、破壊直前に`current_database()`と一致し、かつ`_test`接尾辞であることを再確認する。接続URLや認証情報は保持・表示しない。
- handleをfreezeし、通常の`Database`やforeign objectを`Reflect.apply`で渡してもTRUNCATE前に拒否する。

## 4. env・maintenance jobのfail-closed境界

- `DATABASE_URL`はURLとして解釈でき、protocolが`postgres:`または`postgresql:`の場合だけ受理する。検証エラーにはキー名だけを出す。
- purge CLIは引数0件、またはtest環境で単一の`--now=<+09:00 timestamp>`だけを受理する。未知option、typo、位置引数、裸、空、重複、valid nowとの混在を拒否する。
- purge最上位error logは生message・cause・stackを捨て、job、level、内部error ID、安全な例外クラス名だけを記録する。

## 5. migration・レビュー・Git

- 適用済み想定の`0000`〜`0004`は変更せず、auth unique indexとidentity source hashは順番付き前方migrationとして追加する。
- 空DBと`0000`〜`0004`適用済みDBの双方でmigrationを検証する。既存provider重複やaudit禁止行は自動削除・自動redactしない。
- `phase-1-review.md`と`phase-1-codex-review.md`へ追加reviewの解決状況、migration、test総数、残余リスクを反映する。
- 現在未commitのTask 8・9・10と本ハードニングを、`.superpowers/`と`.claude/settings.local.json`を除外して、最後に日本語Conventional Commit 1件へまとめる。pushは行わない。

## 残余リスク

- 実Google/GitHub OAuth 5シナリオは実資格情報での手動確認が必要。
- custom mutating APIのapplication CSRF、security headers、rate limitはPhase 4のmandatory release gate。
- Phase 2のaudit writerはevent別allowlistを先に追加する。
- Minor findings（guest touch CAS、test migration failure recovery、domain schema drift CI）はPhase 2開始を妨げない追跡事項として残す。
