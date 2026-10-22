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
  echo "Usage: $0 [--self-test|--verify-assets]" >&2
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

# Optional. Public releases download anonymously; a token only raises API rate limits.
github_token() {
  printf '%s' "${GH_TOKEN:-${GITHUB_TOKEN:-}}"
}

WORK=""
CURL_GITHUB_HEADER=""
CURL_PID=""

stop_curl_pid() {
  local pid="${CURL_PID:-}" child
  CURL_PID=""
  [[ -n "$pid" ]] || return 0
  for child in $(ps -o pid= --ppid "$pid" 2>/dev/null || true); do
    kill -TERM "$child" 2>/dev/null || true
  done
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

install_proxy_cleanup() {
  stop_curl_pid
  if [[ -n "${CURL_GITHUB_HEADER:-}" ]]; then
    rm -f "$CURL_GITHUB_HEADER"
    CURL_GITHUB_HEADER=""
  fi
  if [[ -n "${WORK:-}" ]]; then
    rm -rf "$WORK"
    WORK=""
  fi
}

interrupt_install_proxy() {
  install_proxy_cleanup
  exit "$1"
}

register_install_proxy_cleanup() {
  trap 'install_proxy_cleanup' EXIT
  trap 'interrupt_install_proxy 130' INT
  trap 'interrupt_install_proxy 143' TERM
}

register_install_proxy_cleanup

curl_github() {
  local url="$1"
  shift
  local args=(-fsSL -L -H "User-Agent: llmentary-js-install-proxy")
  local token header_file="" status=0
  token="$(github_token)"
  if [[ -n "$token" ]]; then
    # Keep the bearer token out of curl's process arguments (ps/argv).
    # Re-register in this shell so a backgrounded/subshell call still
    # deletes the header on EXIT/INT/TERM (and before the later WORK trap).
    register_install_proxy_cleanup
    header_file="$(mktemp "${TMPDIR:-/tmp}/llmentary-gh-auth.XXXXXX")"
    CURL_GITHUB_HEADER="$header_file"
    chmod 0600 "$header_file"
    printf 'Authorization: Bearer %s\n' "$token" >"$header_file"
    args+=(-H "@${header_file}")
  fi
  if [[ -n "${CURL_GITHUB_HOLD_FILE:-}" && -n "$header_file" ]]; then
    printf '%s\n' "$header_file" >"$CURL_GITHUB_HOLD_FILE"
  fi
  if [[ "${CURL_GITHUB_PRINT_ARGS:-}" == "1" ]]; then
    printf '%s\n' "${args[@]}" "$@" "$url"
  else
    # Background so INT/TERM can fire while curl is blocked, then wait.
    if command -v setsid >/dev/null 2>&1; then
      setsid curl "${args[@]}" "$@" "$url" &
    else
      curl "${args[@]}" "$@" "$url" &
    fi
    CURL_PID=$!
    wait "$CURL_PID" || status=$?
    CURL_PID=""
  fi
  if [[ -n "$header_file" ]]; then
    rm -f "$header_file"
    if [[ "${CURL_GITHUB_HEADER:-}" == "$header_file" ]]; then
      CURL_GITHUB_HEADER=""
    fi
  fi
  return "$status"
}

list_release_assets() {
  local tag="$1"
  local json
  json="$(curl_github "https://api.github.com/repos/${REPO}/releases/tags/${tag}" -H "Accept: application/vnd.github+json")" || {
    echo "could not read public release $tag for $REPO" >&2
    return 1
  }
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to parse GitHub release metadata" >&2
    return 1
  fi
  printf '%s' "$json" | node --input-type=commonjs -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        process.stderr.write("release metadata is not JSON\n");
        process.exit(1);
      }
      if (!data || !Array.isArray(data.assets) || data.assets.length === 0) {
        process.stderr.write("release listed no assets\n");
        process.exit(1);
      }
      for (const asset of data.assets) {
        if (asset && typeof asset.name === "string" && asset.name) {
          process.stdout.write(`${asset.name}\n`);
        }
      }
    });
  '
}

download_release_asset() {
  local tag="$1" name="$2" dest="$3"
  curl_github "https://github.com/${REPO}/releases/download/${tag}/${name}" -o "$dest"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

pinned_release_assets() {
  local version="$1"
  cat <<EOF
checksums.txt
checksums.txt.sigstore.json
$(proxy_archive_name linux amd64 "$version")
$(proxy_archive_name linux arm64 "$version")
$(proxy_archive_name darwin amd64 "$version")
$(proxy_archive_name darwin arm64 "$version")
$(proxy_archive_name windows amd64 "$version")
$(proxy_archive_name windows arm64 "$version")
EOF
}

# Fail if the pinned GitHub Release is missing checksums, the Sigstore bundle,
# any of the six platform archives, or an SBOM. Used by install and --verify-assets.
verify_pinned_release_assets() {
  local tag="$1" version="$2"
  local names missing=0 required
  names="$(list_release_assets "$tag")"
  if [[ -z "$names" ]]; then
    echo "release $tag listed no assets" >&2
    return 1
  fi
  while IFS= read -r required; do
    [[ -n "$required" ]] || continue
    if ! grep -Fxq "$required" <<<"$names"; then
      echo "release $tag missing asset $required" >&2
      missing=1
    fi
  done < <(pinned_release_assets "$version")
  if ! grep -qi 'sbom' <<<"$names"; then
    echo "release $tag has no SBOM assets" >&2
    missing=1
  fi
  # Corner cases: a previous pin's archives, or zip/tarball suffix swapped.
  if grep -Fxq "llmentary_${version}_windows_amd64.tar.gz" <<<"$names"; then
    echo "release $tag has windows archive with tar.gz suffix" >&2
    missing=1
  fi
  if grep -Fxq "llmentary_${version}_linux_amd64.zip" <<<"$names"; then
    echo "release $tag has linux archive with zip suffix" >&2
    missing=1
  fi
  return "$missing"
}

if [[ "${1:-}" == "--self-test" ]]; then
  tag="$(read_proxy_tag)"
  version="${tag#v}"
  [[ "$tag" == "v0.4.1" ]] || {
    echo "PROXY_VERSION must be v0.4.1, got $tag" >&2
    exit 1
  }
  [[ "$(goreleaser_os linux)" == "linux" ]]
  [[ "$(goreleaser_os Darwin)" == "darwin" ]]
  [[ "$(goreleaser_os win32)" == "windows" ]]
  [[ "$(goreleaser_arch x86_64)" == "amd64" ]]
  [[ "$(goreleaser_arch arm64)" == "arm64" ]]
  [[ "$(proxy_archive_name linux amd64 "$version")" == "llmentary_0.4.1_linux_amd64.tar.gz" ]]
  [[ "$(proxy_archive_name linux arm64 "$version")" == "llmentary_0.4.1_linux_arm64.tar.gz" ]]
  [[ "$(proxy_archive_name darwin amd64 "$version")" == "llmentary_0.4.1_darwin_amd64.tar.gz" ]]
  [[ "$(proxy_archive_name darwin arm64 "$version")" == "llmentary_0.4.1_darwin_arm64.tar.gz" ]]
  [[ "$(proxy_archive_name windows amd64 "$version")" == "llmentary_0.4.1_windows_amd64.zip" ]]
  [[ "$(proxy_archive_name windows arm64 "$version")" == "llmentary_0.4.1_windows_arm64.zip" ]]
  expected_assets="$(pinned_release_assets "$version")"
  [[ "$(grep -c . <<<"$expected_assets")" == "8" ]]
  grep -Fxq "checksums.txt" <<<"$expected_assets"
  grep -Fxq "checksums.txt.sigstore.json" <<<"$expected_assets"
  grep -Fxq "llmentary_0.4.1_linux_amd64.tar.gz" <<<"$expected_assets"
  grep -Fxq "llmentary_0.4.1_windows_amd64.zip" <<<"$expected_assets"
  ! grep -Fxq "llmentary_0.4.0_linux_amd64.tar.gz" <<<"$expected_assets"
  empty="$(mktemp)"
  [[ "$(file_sha256 "$empty")" == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]]
  rm -f "$empty"
  (
    unset GH_TOKEN GITHUB_TOKEN
    [[ -z "$(github_token)" ]]
  )
  (
    unset GITHUB_TOKEN
    GH_TOKEN="rate-limit-only"
    [[ "$(github_token)" == "rate-limit-only" ]]
  )
  (
    unset GH_TOKEN
    GITHUB_TOKEN="fallback-token"
    [[ "$(github_token)" == "fallback-token" ]]
  )
  (
    unset GITHUB_TOKEN
    GH_TOKEN="should-not-appear-on-argv"
    printed="$(CURL_GITHUB_PRINT_ARGS=1 curl_github "https://example.test/x")"
    [[ "$printed" != *should-not-appear-on-argv* ]]
    [[ "$printed" == *"-H"*$'\n'"@"* ]] || [[ "$printed" == *"@"* ]]
  )
  fake_bin="$(mktemp -d)"
  hold="$(mktemp)"
  ready="$(mktemp)"
  rm -f "$ready"
  printf '%s\n' '#!/usr/bin/env bash' 'if [[ -n "${CURL_FAKE_READY:-}" ]]; then : >"$CURL_FAKE_READY"; fi' 'exec sleep 30' >"$fake_bin/curl"
  chmod +x "$fake_bin/curl"
  (
    unset GITHUB_TOKEN
    export GH_TOKEN="hold-token"
    export CURL_GITHUB_HOLD_FILE="$hold"
    export CURL_FAKE_READY="$ready"
    export PATH="$fake_bin:$PATH"
    curl_github "https://example.test/x"
  ) &
  hold_pid=$!
  header=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
    if [[ -s "$hold" && -f "$ready" ]]; then
      header="$(cat "$hold")"
      [[ -n "$header" && -f "$header" ]] && break
    fi
    sleep 0.05
  done
  if [[ -z "$header" || ! -f "$header" || ! -f "$ready" ]]; then
    kill -TERM "$hold_pid" 2>/dev/null || true
    wait "$hold_pid" 2>/dev/null || true
    rm -rf "$fake_bin" "$hold" "$ready"
    echo "blocking fake curl did not start" >&2
    exit 1
  fi
  start=$SECONDS
  kill -TERM "$hold_pid" 2>/dev/null || true
  wait "$hold_pid" 2>/dev/null || true
  elapsed=$((SECONDS - start))
  if [[ "$elapsed" -ge 2 ]]; then
    rm -rf "$fake_bin" "$hold" "$ready"
    echo "TERM did not stop a blocked curl in time (${elapsed}s)" >&2
    exit 1
  fi
  [[ ! -f "$header" ]]
  rm -rf "$fake_bin" "$hold" "$ready"
  echo "install-proxy self-test: ok (pin $tag)"
  exit 0
fi

if [[ "${1:-}" == "--verify-assets" ]]; then
  tag="$(read_proxy_tag)"
  version="${tag#v}"
  verify_pinned_release_assets "$tag" "$version"
  echo "install-proxy verify-assets: ok (pin $tag)"
  exit 0
fi

if [[ $# -ne 0 ]]; then
  usage
fi

TAG="$(read_proxy_tag)"
if [[ -z "$TAG" ]]; then
  echo "PROXY_VERSION is empty" >&2
  exit 1
fi
VERSION="${TAG#v}"
verify_pinned_release_assets "$TAG" "$VERSION"

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

download_release_asset "$TAG" "checksums.txt" "$WORK/checksums.txt"
download_release_asset "$TAG" "checksums.txt.sigstore.json" "$WORK/checksums.txt.sigstore.json"
download_release_asset "$TAG" "$ASSET" "$WORK/$ASSET"

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
