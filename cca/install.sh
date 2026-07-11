#!/usr/bin/env sh
set -eu

OWNER=${CCTK_OWNER:-kostenuksoft}
REPO=${CCTK_REPO:-cctk}
REF=${CCTK_REF:-master}
CCTK_HOME=${CCTK_HOME:-$HOME/.local/share/cctk}

BIN="${CCA_BIN_DIR:-$HOME/.local/bin}"
SHIM="$BIN/cca"
ACTION=install
RUNTIME=
SETUP=

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall | -u | remove) ACTION=uninstall ;;
    --node) RUNTIME=node ;;
    --bun) RUNTIME=bun ;;
    --setup) shift; SETUP=${1:-} ;;
    --setup=*) SETUP=${1#*=} ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

case "$SETUP" in
  '' | bun | node) : ;;
  *) echo "--setup must be bun or node" >&2; exit 1 ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }

node_ok() {
  have node || return 1
  ver=$(node -p 'process.versions.node')
  major=${ver%%.*}
  rest=${ver#*.}
  minor=${rest%%.*}
  [ "$major" -gt 23 ] || { [ "$major" -eq 23 ] && [ "$minor" -ge 6 ]; }
}

setup_runtime() {
  if [ "$1" = bun ]; then
    echo "installing bun (bun.sh)..."
    have curl || have wget || {
      echo "need curl or wget to install bun" >&2
      exit 1
    }
    if have curl; then
      curl -fsSL https://bun.sh/install | bash
    else
      wget -qO- https://bun.sh/install | bash
    fi
    if [ -d "$HOME/.bun/bin" ]; then PATH="$HOME/.bun/bin:$PATH"; fi
  else
    if have n; then
      n lts
    elif have brew; then
      brew upgrade node || brew install node
    else
      echo "no supported node updater (n or brew) found - update node from https://nodejs.org" >&2
      exit 1
    fi
  fi
}

if [ "$ACTION" = uninstall ]; then
  if [ -f "$SHIM" ]; then
    rm -f "$SHIM"
    echo "removed $SHIM"
  else
    echo "no cca shim at $SHIM"
  fi
  case "$(basename "${SHELL:-sh}")" in
    zsh) RC="${ZDOTDIR:-$HOME}/.zshrc"; LINE="export PATH=\"$BIN:\$PATH\"" ;;
    bash) RC="$HOME/.bashrc"; LINE="export PATH=\"$BIN:\$PATH\"" ;;
    fish) RC="$HOME/.config/fish/config.fish"; LINE="fish_add_path $BIN" ;;
    *) RC="$HOME/.profile"; LINE="export PATH=\"$BIN:\$PATH\"" ;;
  esac
  if [ -f "$RC" ] && grep -qxF "$LINE" "$RC"; then
    grep -vxF "$LINE" "$RC" > "$RC.cca-tmp" || true
    mv "$RC.cca-tmp" "$RC"
    echo "removed $BIN from PATH in $RC — restart your shell"
  fi
  echo "note: fetched source (if any) left at $CCTK_HOME — remove it by hand if you want it gone"
  exit 0
fi

SELF_DIR=
[ -f "$0" ] && SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/cca.ts" ]; then
  SRC="$SELF_DIR"
  echo "using local checkout: $SRC"
else
  echo "fetching $OWNER/$REPO@$REF"
  have curl || have wget || {
    echo "need curl or wget to download the source" >&2
    exit 1
  }
  have tar || {
    echo "need tar to unpack the source" >&2
    exit 1
  }
  tmp=$(mktemp -d)
  url="https://codeload.github.com/$OWNER/$REPO/tar.gz/refs/heads/$REF"
  if have curl; then
    curl -fsSL "$url" -o "$tmp/src.tgz"
  else
    wget -qO "$tmp/src.tgz" "$url"
  fi
  mkdir -p "$CCTK_HOME"
  tar -xzf "$tmp/src.tgz" --strip-components=1 -C "$CCTK_HOME"
  rm -rf "$tmp"
  SRC="$CCTK_HOME/cca"
  [ -f "$SRC/cca.ts" ] || {
    echo "download did not contain cca/cca.ts — is the repo public and CCTK_REF=$REF correct?" >&2
    exit 1
  }
  echo "fetched into $CCTK_HOME"
fi

if [ -n "$SETUP" ]; then
  setup_runtime "$SETUP"
  if [ "$SETUP" = bun ] && [ -z "$RUNTIME" ]; then RUNTIME=bun; fi
fi

if [ -z "$RUNTIME" ]; then
  if node_ok; then
    RUNTIME=node
  elif have bun; then
    RUNTIME=bun
  elif have node; then
    echo "node $(node -p 'process.versions.node') cannot run TypeScript without a flag; use node >= 23.6 or install bun" >&2
    exit 1
  else
    echo "need node (>=23.6) or bun on PATH" >&2
    exit 1
  fi
fi

have "$RUNTIME" || {
  echo "$RUNTIME not found on PATH" >&2
  exit 1
}

if [ "$RUNTIME" = node ]; then
  ver=$(node -p 'process.versions.node')
  major=${ver%%.*}
  rest=${ver#*.}
  minor=${rest%%.*}
  if [ "$major" -lt 23 ] || { [ "$major" -eq 23 ] && [ "$minor" -lt 6 ]; }; then
    echo "node $ver cannot run TypeScript without a flag; use node >= 23.6 or run with --bun" >&2
    exit 1
  fi
fi

RUNTIME_BIN=$(command -v "$RUNTIME")
mkdir -p "$BIN"
cat > "$SHIM" <<EOF
#!/usr/bin/env sh
exec "$RUNTIME_BIN" "$SRC/cca.ts" "\$@"
EOF
chmod 0755 "$SHIM"
echo "installed cca ($RUNTIME) -> $SHIM"

case ":$PATH:" in
  *":$BIN:"*) : ;;
  *)
    case "$(basename "${SHELL:-sh}")" in
      zsh) RC="${ZDOTDIR:-$HOME}/.zshrc"; LINE="export PATH=\"$BIN:\$PATH\"" ;;
      bash) RC="$HOME/.bashrc"; LINE="export PATH=\"$BIN:\$PATH\"" ;;
      fish) RC="$HOME/.config/fish/config.fish"; LINE="fish_add_path $BIN" ;;
      *) RC="$HOME/.profile"; LINE="export PATH=\"$BIN:\$PATH\"" ;;
    esac
    mkdir -p "$(dirname "$RC")"
    if [ -f "$RC" ] && grep -qF "$BIN" "$RC"; then
      echo "note: $BIN already referenced in $RC — restart your shell"
    else
      printf '%s\n' "$LINE" >> "$RC"
      echo "added $BIN to PATH in $RC — restart your shell (or: source $RC)"
    fi
    ;;
esac
