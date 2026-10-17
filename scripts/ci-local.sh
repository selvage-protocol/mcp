#!/usr/bin/env bash
#
# Runs the steps of .github/workflows/ci.yml on this machine, without containers (this host
# has no Docker or Podman, so `act` cannot run here).
#
#   scripts/ci-local.sh checks   # the `checks` job: install, typecheck, the server's suite
#   scripts/ci-local.sh lint     # actionlint over the workflow files
#   scripts/ci-local.sh links    # lychee over README.md: every relative link and every URL the
#                                # reader-facing prose carries
#   scripts/ci-local.sh all      # lint + checks + links
#
# Keep all three of those in step with the workflow — they run the same commands, so that a red
# job is found here rather than on a runner.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

# `/tmp` is a RAM-backed tmpfs on some hosts, and building there has taken a machine down
# before; keep every artefact inside the checkout.
export TMPDIR="$repo_root/.tmp"
mkdir -p "$TMPDIR"

say() { printf '\n=== %s ===\n' "$*"; }

# The runner has no nix and installs the pinned lychee release instead, so on this host the
# checker comes from nixpkgs when it is not already on PATH — and inside `nix develop` it is,
# because the flake's hook set puts it there.
run_lychee() {
  if command -v lychee >/dev/null 2>&1; then
    lychee "$@"
  else
    nix shell nixpkgs#lychee -c lychee "$@"
  fi
}

job_checks() {
  say "checks: install"
  npm ci --no-audit --no-fund
  say "checks: typecheck"
  npm run typecheck
  say "checks: the server's suite"
  npm test
}

job_lint() {
  say "lint: actionlint over the workflows"
  nix shell nixpkgs#actionlint -c actionlint
}

# The scope is this repository's reader-facing front matter and not every Markdown file it holds:
# `vendor/` is a copy of another repository's tree, checked where it is written. `docs/` is not
# named yet because it does not exist; the first page to land there joins this argument and the
# workflow's, and `lychee.toml` says so.
job_links() {
  say "links: lychee over README.md"
  run_lychee --config lychee.toml --no-progress README.md
}

case "${1:-all}" in
  checks) job_checks ;;
  lint) job_lint ;;
  links) job_links ;;
  all) job_lint; job_checks; job_links ;;
  *)
    printf 'usage: %s [checks|lint|links|all]\n' "$0" >&2
    exit 2
    ;;
esac
