#!/usr/bin/env bash
# Test-driver-owned, read-only process observation in the disposable guest.
set -u
artifact_dir=$1
mkdir -p "$artifact_dir/proc"
trap 'exit 0' TERM INT
while [[ ! -e "$artifact_dir/stop" ]]; do
  for process_dir in /proc/[0-9]*; do
    if ! read -r process_name < "$process_dir/comm" 2>/dev/null; then continue; fi
    if [[ "$process_name" != node ]]; then continue; fi
    process_id=${process_dir##*/}
    target="$artifact_dir/proc/$process_id"
    mkdir -p "$target"
    date -u +%FT%TZ > "$target/observed-at.txt"
    for field in stat status cmdline maps limits; do
      cat "$process_dir/$field" > "$target/$field.next" 2>/dev/null &&
        mv "$target/$field.next" "$target/$field"
    done
    readlink "$process_dir/exe" > "$target/exe.next" 2>/dev/null &&
      mv "$target/exe.next" "$target/exe"
  done
  sleep 1
done

touch "$artifact_dir/stopped"
