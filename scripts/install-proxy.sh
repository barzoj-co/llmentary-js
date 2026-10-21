#!/usr/bin/env bash
# Install the PROXY_VERSION GitHub Release binary (checksum + Sigstore verified).
# Cosign keyless identity is goreleaser.yml@refs/heads/main, not the tag ref.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${LLMENTARY_REPO:-barzoj-co/llmentary}"
DEST_DIR="${LLMENTARY_INSTALL_DIR:-$ROOT/.bin}"
# renovate: datasource=github-releases depName=sigstore/cosign
COSIGN_VERSION="${COSIGN_VERSION:-2.6.1}"
COSIGN_IDENTITY="${COSIGN_IDENTITY:-https://github.com/barzoj-co/llmentary/.github/workflows/goreleaser.yml@refs/heads/main}"
COSIGN_ISSUER="${COSIGN_ISSUER:-https://token.actions.githubusercontent.com}"

usage() {
  echo "Usage: $0 [--self-test]" >&2
  exit 2
}

goreleaser_os() {
  case "$1" in
    linux | Linux) echo linux ;;
    darwin | Darwin) echo darwin ;;
    win32 | windows | MINGW* | MSYS* | CYGWIN*) echo windows ;;
    *)
      echo "unsupported os: $1" >&2
      return 1
      ;;
  esac
}

goreleaser_arch() {
  case "$1" in
    x64 | amd64 | x86_64) echo amd64 ;;
    arm64 | aarch64) echo arm64 ;;
    *)
      echo "unsupported arch: $1" >&2
      return 1
      ;;
  esac
}

proxy_archive_name() {
  local goos="$1" goarch="$2" version="$3"
  local ext="tar.gz"
  if [[ "$goos" == "windows" ]]; then
    ext="zip"
  fi
  echo "llmentary_${version}_${goos}_${goarch}.${ext}"
}

read_proxy_tag() {
  tr -d '[:space:]' <"$ROOT/PROXY_VERSION"
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "need sha256sum or shasum -a 256" >&2
    return 1
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

if [[ "${1:-}" == "--self-test" ]]; then
  tag="$(read_proxy_tag)"
  version="${tag#v}"
  [[ "$tag" == "v0.3.0" ]] || {
    echo "PROXY_VERSION must be v0.3.0, got $tag" >&2
    exit 1
  }
  [[ "$(goreleaser_os linux)" == "linux" ]]
  [[ "$(goreleaser_os Darwin)" == "darwin" ]]
  [[ "$(goreleaser_os win32)" == "windows" ]]
  [[ "$(goreleaser_arch x86_64)" == "amd64" ]]
  [[ "$(goreleaser_arch arm64)" == "arm64" ]]
  [[ "$(proxy_archive_name linux amd64 "$version")" == "llmentary_0.3.0_linux_amd64.tar.gz" ]]
  [[ "$(proxy_archive_name darwin arm64 "$version")" == "llmentary_0.3.0_darwin_arm64.tar.gz" ]]
  [[ "$(proxy_archive_name windows amd64 "$version")" == "llmentary_0.3.0_windows_amd64.zip" ]]
  [[ "$(proxy_archive_name windows arm64 "$version")" == "llmentary_0.3.0_windows_arm64.zip" ]]
  empty="$(mktemp)"
  [[ "$(file_sha256 "$empty")" == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]]
  rm -f "$empty"
  echo "install-proxy self-test: ok (pin $tag)"
  exit 0
fi

if [[ $# -ne 0 ]]; then
  usage
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required to download the llmentary GitHub Release" >&2
  exit 1
fi

TAG="$(read_proxy_tag)"
if [[ -z "$TAG" ]]; then
  echo "PROXY_VERSION is empty" >&2
  exit 1
fi
VERSION="${TAG#v}"

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
GOOS="$(goreleaser_os "$HOST_OS")"
GOARCH="$(goreleaser_arch "$HOST_ARCH")"
ASSET="$(proxy_archive_name "$GOOS" "$GOARCH" "$VERSION")"
BIN_NAME="llmentary"
if [[ "$GOOS" == "windows" ]]; then
  BIN_NAME="llmentary.exe"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/llmentary-proxy.XXXXXX")"
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

gh release download "$TAG" --repo "$REPO" --dir "$WORK" \
  --pattern "checksums.txt" \
  --pattern "checksums.txt.sigstore.json" \
  --pattern "$ASSET"

if [[ ! -f "$WORK/$ASSET" ]]; then
  echo "release $TAG did not contain $ASSET" >&2
  exit 1
fi
if [[ ! -f "$WORK/checksums.txt" ]]; then
  echo "release $TAG did not contain checksums.txt" >&2
  exit 1
fi
if [[ ! -f "$WORK/checksums.txt.sigstore.json" ]]; then
  echo "release $TAG did not contain checksums.txt.sigstore.json" >&2
  exit 1
fi

if [[ -n "${COSIGN_BIN:-}" ]]; then
  COSIGN="$COSIGN_BIN"
else
  COSIGN_OS="linux"
  COSIGN_ARCH="amd64"
  case "$(uname -s)" in
    Darwin) COSIGN_OS="darwin" ;;
    Linux) COSIGN_OS="linux" ;;
    *)
      echo "install cosign and set COSIGN_BIN to verify checksums.txt" >&2
      exit 1
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) COSIGN_ARCH="amd64" ;;
    arm64 | aarch64) COSIGN_ARCH="arm64" ;;
    *)
      echo "install cosign and set COSIGN_BIN to verify checksums.txt" >&2
      exit 1
      ;;
  esac
  COSIGN="$WORK/cosign"
  curl -fsSL -o "$COSIGN" \
    "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-${COSIGN_OS}-${COSIGN_ARCH}"
  chmod +x "$COSIGN"
fi

"$COSIGN" verify-blob \
  --bundle "$WORK/checksums.txt.sigstore.json" \
  --certificate-identity "$COSIGN_IDENTITY" \
  --certificate-oidc-issuer "$COSIGN_ISSUER" \
  "$WORK/checksums.txt"

EXPECTED="$(
  awk -v name="$ASSET" '
    $NF == name || $NF == ("*" name) { print $1; exit }
  ' "$WORK/checksums.txt"
)"
if [[ -z "$EXPECTED" ]]; then
  echo "checksums.txt does not list $ASSET" >&2
  exit 1
fi
ACTUAL="$(file_sha256 "$WORK/$ASSET")"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "sha256 mismatch for $ASSET: expected $EXPECTED, got $ACTUAL" >&2
  exit 1
fi

EXTRACT="$WORK/extract"
mkdir -p "$EXTRACT"
if [[ "$ASSET" == *.zip ]]; then
  unzip -q "$WORK/$ASSET" -d "$EXTRACT"
else
  tar -xzf "$WORK/$ASSET" -C "$EXTRACT"
fi

FOUND="$(find "$EXTRACT" -type f \( -name llmentary -o -name llmentary.exe \) | head -n 1)"
if [[ -z "$FOUND" ]]; then
  echo "no llmentary binary inside $ASSET" >&2
  exit 1
fi

CONTRACT="$(find "$EXTRACT" -type f \( -name openapi.yaml -o -name openapi.yml \) | head -n 1)"
if [[ -z "$CONTRACT" ]]; then
  echo "no OpenAPI contract inside $ASSET" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/$BIN_NAME"
cp "$FOUND" "$DEST"
chmod +x "$DEST"

cp "$CONTRACT" "$DEST_DIR/openapi.yaml"
cp "$CONTRACT" "$ROOT/openapi.yaml"

VERSION_OUT="$("$DEST" --version)"
if [[ "$VERSION_OUT" != "llmentary ${VERSION}"* ]]; then
  echo "unexpected --version: $VERSION_OUT" >&2
  exit 1
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "LLMENTARY_BIN=$DEST" >>"$GITHUB_ENV"
fi

echo "$DEST"
echo "$VERSION_OUT" >&2
