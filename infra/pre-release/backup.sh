#!/bin/sh
set -eu

# 引数なし: 毎晩の分。JSTの日付ごとに1本だけ作り、既にあれば何もしない。
# --predeploy: デプロイ直前の分。時刻付きの名前で毎回必ず作る。
#   同じ日に何度デプロイしても、それぞれの直前の状態へ戻れるようにするため。

# デプロイ直前の分を手元に残す本数。戻すのはたいてい直前の1本なので、数本で足りる。
PREDEPLOY_KEEP=5

mode=daily
case ${1:-} in
  '') ;;
  --predeploy) mode=predeploy ;;
  *)
    printf '%s\n' "不明な引数: $1" >&2
    printf '%s\n' '使い方: backup.sh [--predeploy]' >&2
    exit 2
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
backup_dir=${BACKUP_DIR:-/var/backups/tango}

if [ "$mode" = predeploy ]; then
  stamp=$(TZ=Asia/Tokyo date +%Y%m%d-%H%M%S)
  destination="$backup_dir/tango-predeploy-$stamp.dump"
else
  stamp=$(TZ=Asia/Tokyo date +%Y-%m-%d)
  destination="$backup_dir/tango-$stamp.dump"
fi

umask 077
mkdir -p "$backup_dir"

if [ -f "$destination" ]; then
  printf '%s\n' "本日分のバックアップは既に存在します: $destination"
  exit 0
fi

temporary=$(mktemp "$backup_dir/.tango-$stamp.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM

docker compose --project-directory "$script_dir" \
  --env-file "$script_dir/.env" \
  -f "$script_dir/compose.yml" \
  exec -T tango-postgres pg_dump -U tango -d tango -Fc >"$temporary"

mv "$temporary" "$destination"
trap - EXIT HUP INT TERM
printf '%s\n' "バックアップを作成しました: $destination"

# デプロイ直前の分は溜まり続けないよう、新しい順に決めた本数だけ残す。
# 名前に時刻が入っているので、名前の降順がそのまま新しい順になる。
if [ "$mode" = predeploy ]; then
  count=0
  for file in $(ls -1r "$backup_dir"/tango-predeploy-*.dump 2>/dev/null); do
    count=$((count + 1))
    if [ "$count" -gt "$PREDEPLOY_KEEP" ]; then
      rm -f "$file"
    fi
  done
fi
