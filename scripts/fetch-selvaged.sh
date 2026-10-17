#!/usr/bin/env bash
#
# Puts a real `selvaged` in a directory and prints the path of the binary:
#
#   SELVAGE_SELVAGED=$(scripts/fetch-selvaged.sh) npm run test:e2e
#
# The binary comes out of the published image `ghcr.io/selvage-protocol/selvaged`, read from the
# registry anonymously the way `docker pull` reads it. That image is a static binary on `scratch`,
# so the file it holds runs directly: no container, no Rust toolchain, no cargo cache, and a
# second of network instead of a build.
#
# The tag names the release *and* the commit it was built from, so the bytes cannot move under the
# moving `<version>` alias; every layer is checked against the digest its own manifest carries,
# and the binary has to print the version the tag names. A bump is an edit to the constants below.
#
# The destination defaults to this checkout's `.tmp/selvaged` — never `/tmp`, which is RAM-backed
# on some hosts.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
dest=${1:-$repo_root/.tmp/selvaged}

image=selvage-protocol/selvaged
tag=0.5.8-56335e6
version=0.5.8
registry=https://ghcr.io

case $(uname -m) in
  x86_64) platform=amd64 ;;
  aarch64 | arm64) platform=arm64 ;;
  *)
    printf '%s: %s publishes no %s binary\n' "$0" "$image" "$(uname -m)" >&2
    exit 2
    ;;
esac

mkdir -p "$dest"
work=$dest/.fetch
rm -rf "$work"
mkdir -p "$work/rootfs"

# An anonymous pull token: the package is public, so nothing here is a credential.
token=$(curl -fsS "$registry/token?scope=repository:$image:pull&service=ghcr.io" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')

curl -fsS -H "Authorization: Bearer $token" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  "$registry/v2/$image/manifests/$tag" -o "$work/index.json"

digest=$(python3 - "$work/index.json" "$platform" <<'PY'
import json, sys
for manifest in json.load(open(sys.argv[1]))["manifests"]:
    platform = manifest["platform"]
    if platform["os"] == "linux" and platform["architecture"] == sys.argv[2]:
        print(manifest["digest"])
        break
else:
    raise SystemExit(f"the index for this tag carries no linux/{sys.argv[2]} manifest")
PY
)

curl -fsS -H "Authorization: Bearer $token" \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "$registry/v2/$image/manifests/$digest" -o "$work/manifest.json"

for layer in $(python3 -c 'import json, sys; print("\n".join(layer["digest"] for layer in json.load(open(sys.argv[1]))["layers"]))' "$work/manifest.json"); do
  curl -fsSL -H "Authorization: Bearer $token" "$registry/v2/$image/blobs/$layer" -o "$work/layer.tgz"
  printf '%s  %s\n' "${layer#sha256:}" "$work/layer.tgz" | sha256sum -c - >&2
  tar -xzf "$work/layer.tgz" -C "$work/rootfs"
done

if [ ! -f "$work/rootfs/selvaged" ]; then
  printf '%s: the image holds no /selvaged\n' "$0" >&2
  exit 1
fi
install -m 0755 "$work/rootfs/selvaged" "$dest/selvaged"
rm -rf "$work"

said=$("$dest/selvaged" --version)
if [ "$said" != "selvaged/$version" ]; then
  printf '%s: the fetched binary says %s, want selvaged/%s\n' "$0" "$said" "$version" >&2
  exit 1
fi

printf '%s: %s from %s:%s\n' "$0" "$said" "$image" "$tag" >&2
printf '%s\n' "$dest/selvaged"
