#!/bin/sh
set -eu

# バックアップと退避が「すべて成功したとき」だけ Uptime Kuma へ ping する。
# systemd の ExecStartPost は、先行する ExecStart が失敗すると実行されない。
# その性質をそのまま使い、失敗した日は ping が飛ばない状態にする。
# Kuma 側は heartbeat が途切れたことで異常を検知する（監視の向きを逆にしている）。
#
# push URL はトークンを含むため、リポジトリではなく本番のファイルに置く。

url_file=${UPTIME_PUSH_URL_FILE:-/etc/tango/backup/uptime-push-url}

# 監視を設定していない環境では何もしない。設定漏れでバックアップを失敗扱いにしない。
if [ ! -f "$url_file" ]; then
  exit 0
fi

url=$(cat "$url_file")
if [ -z "$url" ]; then
  printf '%s\n' "push URL が空: $url_file" >&2
  exit 1
fi

# 失敗したら終了コードを返す。監視が壊れていることも気付ける必要がある。
curl -fsS --max-time 20 "$url" >/dev/null
