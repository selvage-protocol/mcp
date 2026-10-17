#!/usr/bin/env bash
#
# Runs the steps of .github/workflows/ci.yml on this machine, without containers (this host
# has no Docker or Podman, so `act` cannot run here).
#
#   scripts/ci-local.sh checks   # the `checks` job: install, build, typecheck, the server's suite
#   scripts/ci-local.sh e2e      # the two-process proof: two MCP servers over stdio, one room on
#                                # a real `selvaged` — the published binary, fetched as the job does
#   scripts/ci-local.sh lint     # actionlint over the workflow files
#   scripts/ci-local.sh links    # lychee over README.md: every relative link and every URL the
#                                # reader-facing prose carries
#   scripts/ci-local.sh all      # lint + checks + e2e + links
#
# Keep `checks`, `lint`, `links` and `e2e` in step with the workflow — they run the same commands,
# so that a red job is found here rather than on a runner. `e2e` is the one step whose server the
# job gets in a step of its own: the runner has no sibling `reference_server` checkout, so both
# call `scripts/fetch-selvaged.sh` for the published binary and then `npm run test:e2e`. A
# `SELVAGE_SELVAGED` already in the environment names a different server — a sibling build — and
# skips the fetch.
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
  # `npm ci` runs `prepare`, which is this, and so does the `prepare` of a `npm pack` or a git
  # install; it is named here so that a build that cannot run is red on its own line.
  say "checks: build the artifact"
  npm run build
  say "checks: typecheck"
  npm run typecheck
  say "checks: the server's suite"
  npm test
}

job_e2e() {
  local binary=${SELVAGE_SELVAGED:-}
  if [ -z "$binary" ]; then
    say "e2e: the published selvaged"
    binary=$(scripts/fetch-selvaged.sh)
  fi
  say "e2e: two MCP servers and a real selvaged"
  SELVAGE_SELVAGED=$binary npm run test:e2e
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
  e2e) job_e2e ;;
  lint) job_lint ;;
  links) job_links ;;
  all) job_lint; job_checks; job_e2e; job_links ;;
  *)
    printf 'usage: %s [checks|e2e|lint|links|all]\n' "$0" >&2
    exit 2
    ;;
esac
