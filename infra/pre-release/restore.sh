#!/bin/sh
set -eu

# backup.sh が作った custom dump を復元する。
# 既定では検証用の別データベースへ復元する。取り違えても本番が消えないため。
# 本番の tango そのものへ戻すのは、事故と区別がつかない操作なので明示的に要求させる。

usage() {
  cat <<'USAGE'
使い方:
  restore.sh <dump-file> [--into <dbname>]

既定の復元先は tango_restore_<YYYYMMDD> で、既存のデータベースには触れない。
本番の tango へ戻す場合は次の両方が要る:
  --into tango
  TANGO_RESTORE_CONFIRM=yes
本番へ戻す前に tango-app を止めること。アプリが書き込みながらの復元は不整合になる。
USAGE
}

if [ $# -lt 1 ]; then
  usage
  exit 2
fi

dump_file=$1
shift

target=""
while [ $# -gt 0 ]; do
  case $1 in
    --into)
      if [ $# -lt 2 ]; then
        usage
        exit 2
      fi
      target=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf '%s\n' "不明な引数: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ ! -f "$dump_file" ]; then
  printf '%s\n' "ダンプが見つかりません: $dump_file" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
today=$(TZ=Asia/Tokyo date +%Y%m%d)

if [ -z "$target" ]; then
  target="tango_restore_$today"
fi

compose() {
  docker compose --project-directory "$script_dir" \
    --env-file "$script_dir/.env" \
    -f "$script_dir/compose.yml" \
    "$@"
}

if [ "$target" = tango ]; then
  if [ "${TANGO_RESTORE_CONFIRM:-}" != yes ]; then
    printf '%s\n' '本番のtangoへ復元するには TANGO_RESTORE_CONFIRM=yes が要る。' >&2
    exit 1
  fi

  # 稼働中のアプリが書き込んだままでは、復元した状態と食い違う。
  if [ -n "$(compose ps --status running --services | grep -x tango-app || true)" ]; then
    printf '%s\n' 'tango-app が動いている。先に停止すること。' >&2
    exit 1
  fi

  printf '%s\n' "本番の tango を削除して復元する: $dump_file"
  compose exec -T tango-postgres dropdb -U tango --if-exists --force tango
fi

compose exec -T tango-postgres createdb -U tango -O tango "$target"

# --exit-on-error を付ける。途中で失敗した半端な復元を成功に見せない。
compose exec -T tango-postgres \
  pg_restore -U tango -d "$target" --no-owner --exit-on-error <"$dump_file"

count=$(compose exec -T tango-postgres \
  psql -U tango -d "$target" -tAc \
  "select count(*) from information_schema.tables where table_schema = 'public'")

printf '%s\n' "復元しました: $target (public のテーブル数: $count)"

if [ "$target" != tango ]; then
  printf '%s\n' "確認が済んだら破棄する: docker compose exec -T tango-postgres dropdb -U tango $target"
fi
