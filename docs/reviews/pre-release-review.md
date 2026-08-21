# Tango プレリリース確認記録

- 確認日: 2026-08-21 JST
- 対象ブランチ: `feat/pre-release-study`
- 対象範囲: `c375f98` からTask 15まで
- 公開先: `https://tango.warasugi.com`

## 受け入れ条件

| # | 判定 | 確認内容 |
| --- | --- | --- |
| 1 | PASS（自動テスト） | ゲスト開始、デッキ/カードAPI、Study API、学習コンポーネントを各境界で確認。表→答え→4評価と、応答前に次カードへ進まないことを検証した。Turnstile資格情報を使う実ブラウザ通し確認は公開作業時に行う。 |
| 2 | PASS | JSON `tango.content` v1とCSVを解析し、全件検証後に一括作成するAPI/画面テストが成功。 |
| 3 | PASS | 実PostgreSQLのStudyRepositoryで、04:00 JST前後を別学習日として新規上限がリセットされることを確認。 |
| 4 | PASS | 実PostgreSQLで同一冪等キーの即時再送が二重採点されず、Webでも通信失敗時に同じキーを再利用することを確認。 |
| 5 | PASS（所有者境界） | 実PostgreSQLで別principalのデッキが一覧に出ず、カードの読み書きも拒否されることを確認。別ブラウザの実操作は公開作業時のsmoke testで再確認する。 |
| 6 | PASS | frozen install、全368テスト/全型検査、全workspace build、専用空DBへのmigration、auth schema check、schema driftなしを確認。 |
| 7 | PASS | `docs/todo/pre-release-deferred.md` に最低指定項目と実装時に判明した追加見送りを3列で記録。 |

## 配置資材

- Docker imageの実ビルドに成功し、Bun 1.3.14上でAPIとSPAを生成した。
- Compose展開は `tango-postgres` / `tango-app` / `cloudflared` の3サービスで成功した。
- PostgreSQLはホストへポートを公開せず、アプリ起動前にmigrationを実行する。
- アプリ秘密値、DB接続URL、Tunnel tokenはファイルでマウントする。
- `backup.sh` はJSTの日付ごとに1個のcustom dumpを原子的に作る。LXC側のtimer設定と別障害ドメインへの複製は公開作業に含める。

## 公開前に利用者側で必要なもの

1. Turnstile site key / secret
2. Google/GitHub OAuth client ID / secret（画面にログイン導線は出さないが起動契約上必要）
3. Cloudflare Tunnel tokenと、`tango.warasugi.com` → `http://tango-app:3000` の公開ホスト名設定
4. Debian 12/13 LXC、Docker Engine / Compose v2、secret file、バックアップ先

資格情報投入後に、ゲスト開始から1回の復習までと、別ブラウザでの所有者分離をsmoke testして公開判断する。pushと本番適用はこの確認記録の対象外。
