#!/bin/sh
# Only bootstrap the pinned Node executable; preparation and launching are TypeScript.
set -eu
comms_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
comms_lock="$comms_root/scripts/linux-runtime-lock.json"
# Read the flat node stanza without needing an installed JSON interpreter.
comms_node_stanza=$(sed -n '/^  "node": {$/,/^  },$/p' "$comms_lock")
comms_name=$(printf '%s\n' "$comms_node_stanza" | sed -n 's/^    "name": "\([^"]*\)",$/\1/p')
comms_url=$(printf '%s\n' "$comms_node_stanza" | sed -n 's/^    "url": "\([^"]*\)",$/\1/p')
comms_sha=$(printf '%s\n' "$comms_node_stanza" | sed -n 's/^    "sha256": "\([a-f0-9]*\)"$/\1/p')
printf '%s\n' "$comms_name" | grep -Eq '^node-v[0-9]+\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$' || { echo 'Invalid pinned Node archive name' >&2; exit 1; }
[ "${#comms_sha}" -eq 64 ] || { echo 'Invalid pinned Node checksum' >&2; exit 1; }
comms_version=${comms_name#node-}
comms_version=${comms_version%-linux-x64.tar.xz}
[ "$comms_url" = "https://nodejs.org/dist/$comms_version/$comms_name" ] || { echo 'Invalid pinned Node download URL' >&2; exit 1; }
comms_cache="$comms_root/.cache/linux"
comms_node_dir="$comms_cache/${comms_name%.tar.xz}"
if [ ! -x "$comms_node_dir/bin/node" ]; then
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo 'This runtime requires Debian 13 on x86_64' >&2; exit 1; }
  for comms_tool in curl sha256sum tar; do
    command -v "$comms_tool" >/dev/null || { echo "Required bootstrap tool missing: $comms_tool" >&2; exit 1; }
  done
  mkdir -p "$comms_cache/archives"
  comms_archive="$comms_cache/archives/$comms_name"
  comms_verify() { printf '%s  %s\n' "$comms_sha" "$1" | sha256sum -c --status; }
  if [ ! -f "$comms_archive" ] || ! comms_verify "$comms_archive"; then
    comms_partial="$comms_archive.partial"
    trap 'rm -f -- "$comms_partial"' EXIT
    curl --fail --location --proto '=https' --proto-redir '=https' --max-time 180 --output "$comms_partial" "$comms_url"
    comms_verify "$comms_partial" || { echo 'Pinned Node checksum mismatch' >&2; exit 1; }
    mv -- "$comms_partial" "$comms_archive"
    trap - EXIT
  fi
  echo 'Extracting the checksum-verified Node bootstrap…'
  tar -xJf "$comms_archive" -C "$comms_cache" --no-same-owner
fi
if [ "${1-}" = --prepare ]; then
  shift
  [ "$#" -eq 0 ] || { echo 'Usage: sh scripts/linux.sh --prepare' >&2; exit 1; }
  exec "$comms_node_dir/bin/node" "$comms_root/scripts/prepare-linux.ts"
fi
exec "$comms_node_dir/bin/node" "$comms_root/scripts/linux-run.ts" "$@"
