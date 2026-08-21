#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
backup_dir=${BACKUP_DIR:-/var/backups/tango}
today=$(TZ=Asia/Tokyo date +%Y-%m-%d)
destination="$backup_dir/tango-$today.dump"

umask 077
mkdir -p "$backup_dir"

if [ -f "$destination" ]; then
  printf '%s\n' "本日分のバックアップは既に存在します: $destination"
  exit 0
fi

temporary=$(mktemp "$backup_dir/.tango-$today.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM

docker compose --project-directory "$script_dir" \
  --env-file "$script_dir/.env" \
  -f "$script_dir/compose.yml" \
  exec -T tango-postgres pg_dump -U tango -d tango -Fc >"$temporary"

mv "$temporary" "$destination"
trap - EXIT HUP INT TERM
printf '%s\n' "バックアップを作成しました: $destination"
