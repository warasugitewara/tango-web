#!/bin/sh
set -eu

# 当日の dump を暗号化して、別の障害ドメイン（Google Drive）へ退避する。
# backup.sh の直後に走らせる前提。
#
# 本番に置くのは age の「公開鍵」だけにする。秘密鍵をここへ置かないことで、
# この LXC が乗っ取られても、過去に退避した分は復号できない状態を保つ。
# dump にはカード本文と認証情報が入るため、平文で他社のストレージへ送らない。

backup_dir=${BACKUP_DIR:-/var/backups/tango}
recipient_file=${AGE_RECIPIENT_FILE:-/etc/tango/backup/age-recipient.txt}
remote=${RCLONE_REMOTE:-tango-drive:tango-backups}
state_file=${OFFSITE_STATE_FILE:-/var/lib/tango/last-offsite}

today=$(TZ=Asia/Tokyo date +%Y-%m-%d)
source_dump="$backup_dir/tango-$today.dump"

if [ ! -f "$source_dump" ]; then
  printf '%s\n' "本日分の dump が無い: $source_dump" >&2
  exit 1
fi

if [ ! -f "$recipient_file" ]; then
  printf '%s\n' "公開鍵が無い: $recipient_file" >&2
  exit 1
fi

umask 077
encrypted=$(mktemp "$backup_dir/.tango-$today.age.XXXXXX")
trap 'rm -f "$encrypted"' EXIT HUP INT TERM

age --encrypt --recipients-file "$recipient_file" --output "$encrypted" "$source_dump"

remote_name="tango-$today.dump.age"

# 世代整理は対象ディレクトリが無いと失敗する。初回のために先に用意する。
for tier in daily weekly monthly; do
  rclone mkdir "$remote/$tier"
done

rclone copyto "$encrypted" "$remote/daily/$remote_name"

# 週次と月次は日次からの複製で作る。dump を取り直さない。
if [ "$(TZ=Asia/Tokyo date +%u)" = 1 ]; then
  rclone copyto "$encrypted" "$remote/weekly/$remote_name"
fi

if [ "$(TZ=Asia/Tokyo date +%d)" = 01 ]; then
  rclone copyto "$encrypted" "$remote/monthly/$remote_name"
fi

# 保持は仕様どおり daily 7 / weekly 4 / monthly 6。
rclone delete "$remote/daily" --min-age 7d
rclone delete "$remote/weekly" --min-age 28d
rclone delete "$remote/monthly" --min-age 186d

# 手元も 7 世代で足りる。戻すのはたいてい直近で、古い分は Drive 側にある。
find "$backup_dir" -maxdepth 1 -name 'tango-*.dump' -mtime +7 -delete

# 監視が「最後に退避できた時刻」を見るための印。
mkdir -p "$(dirname "$state_file")"
printf '%s\n' "$(TZ=Asia/Tokyo date +%Y-%m-%dT%H:%M:%S%z)" >"$state_file"

printf '%s\n' "退避しました: $remote/daily/$remote_name"
