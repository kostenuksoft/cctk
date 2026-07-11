#!/usr/bin/env sh
set -eu

OWNER=${CCTK_OWNER:-kostenuksoft}
REPO=${CCTK_REPO:-cctk}
REF=${CCTK_REF:-master}
CCTK_HOME=${CCTK_HOME:-$HOME/.local/share/cctk}

CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DEST="$CFG_DIR/statusline.py"
SETTINGS="$CFG_DIR/settings.json"
ACTION=install

for arg in "$@"; do
  case "$arg" in
    --uninstall | -u | remove) ACTION=uninstall ;;
    *)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }
have python3 || {
  echo "need python3 on PATH (statusline is Python, and settings.json is edited with it)" >&2
  exit 1
}

if [ "$ACTION" = uninstall ]; then
  python3 - "$SETTINGS" <<'PY'
import json, os, sys
path = sys.argv[1]
if not os.path.exists(path):
    print("no settings.json at", path); sys.exit(0)
data = json.load(open(path))
if data.pop("statusLine", None) is None:
    print("no statusLine key in", path); sys.exit(0)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("removed statusLine from", path)
PY
  [ -f "$DEST" ] && { rm -f "$DEST"; echo "removed $DEST"; }
  exit 0
fi

SELF_DIR=
[ -f "$0" ] && SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/statusline.py" ]; then
  SRC="$SELF_DIR/statusline.py"
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
  SRC="$CCTK_HOME/statusline/statusline.py"
  [ -f "$SRC" ] || {
    echo "download did not contain statusline/statusline.py — is the repo public and CCTK_REF=$REF correct?" >&2
    exit 1
  }
fi

mkdir -p "$CFG_DIR"
if [ "$SRC" != "$DEST" ]; then
  cp "$SRC" "$DEST"
fi
echo "installed statusline -> $DEST"

python3 - "$SETTINGS" "python3 $DEST" <<'PY'
import json, os, shutil, sys, time
path, cmd = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    shutil.copy(path, path + ".bak-" + time.strftime("%Y%m%d%H%M%S"))
    try:
        data = json.load(open(path))
    except ValueError as e:
        print("existing settings.json is not valid JSON:", e); sys.exit(1)
current = data.get("statusLine")
merged = dict(current) if isinstance(current, dict) else {}
merged["type"] = "command"
merged["command"] = cmd
if current == merged:
    print("statusLine already points here — no change")
else:
    data["statusLine"] = merged
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("wired statusLine ->", cmd)
PY

echo "done — open a new Claude Code session to see it."
