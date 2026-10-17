#!/usr/bin/env bash
#
# The sync engine and the bridge in `vendor/` are vendored, not authored here: the canonical
# copies live in the VS Code client (`selvage-protocol/vscode_client`, its `src/engine` and
# `src/bridge`). `DESIGN.md` §6 splits a client into a sync engine and an editor adapter, and
# this repository is an editor adapter — the server takes part in a session by driving the
# engine that already speaks the wire, so it is copied rather than written a second time.
#
#   scripts/sync-engine.sh [path-to-vscode_client-checkout] [ref]
#
# The default source is the sibling checkout `../vscode_client`, and the default ref is that
# checkout's *published* tree — `refs/remotes/origin/main`, else `main`, else `HEAD`. The
# published ref rather than the working tree, because a working tree carries whatever is
# half-written in it and `ai_notes/scripts/check-workspace.sh` compares cross-repository copies
# against the published ref. The script copies and then reports the difference, so a run either
# brings `vendor/` into agreement or says what it could not.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# The sibling checkout is next to this repository; a repository checked out under another one's
# `.worktrees/` has it two directories further up.
source_dir="${1:-}"
if [[ -z "$source_dir" ]]; then
  for candidate in "$here/../vscode_client" "$here/../../../vscode_client"; do
    if [[ -d "$candidate" ]]; then
      source_dir="$candidate"
      break
    fi
  done
fi

if [[ -z "$source_dir" || ! -d "$source_dir" ]]; then
  printf 'no vscode_client checkout found: pass its path as the first argument\n' >&2
  exit 1
fi

ref="${2:-}"
if [[ -z "$ref" ]]; then
  for candidate in refs/remotes/origin/main main HEAD; do
    if git -C "$source_dir" rev-parse --verify --quiet "$candidate" >/dev/null; then
      ref="$candidate"
      break
    fi
  done
fi
if [[ -z "$ref" ]]; then
  printf '%s names no revision to copy from\n' "$source_dir" >&2
  exit 1
fi

# `/tmp` is RAM-backed on some hosts; keep the scratch inside the checkout.
export TMPDIR="$here/.tmp"
mkdir -p "$TMPDIR"
scratch="$(mktemp -d "$TMPDIR/sync-engine.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

git -C "$source_dir" archive "$ref" src/engine src/bridge | tar -x -C "$scratch"
for part in engine bridge; do
  if [[ ! -d "$scratch/src/$part" ]]; then
    printf 'no src/%s at %s in %s\n' "$part" "$ref" "$source_dir" >&2
    exit 1
  fi
done

for part in engine bridge; do
  mkdir -p "$here/vendor/$part"
  # A module the source has retired must go too, or the copy drifts by addition.
  rm -rf "$here/vendor/$part"
  cp -a "$scratch/src/$part" "$here/vendor/$part"
done

status=0
for part in engine bridge; do
  if ! diff -r "$scratch/src/$part" "$here/vendor/$part"; then
    printf 'vendor/%s differs from %s/src/%s\n' "$part" "$source_dir" "$part" >&2
    status=1
  fi
done
if [[ $status -eq 0 ]]; then
  printf 'vendor/ is %s at %s\n' "$source_dir" "$(git -C "$source_dir" rev-parse --short "$ref")"
fi
exit "$status"
