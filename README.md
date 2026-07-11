![cca — TypeScript](https://img.shields.io/badge/cca-TypeScript-3178C6?logo=typescript&logoColor=white) ![statusline — Python](https://img.shields.io/badge/statusline-Python-3776AB?logo=python&logoColor=white)

A few small tools I built for my own Claude Code workflow and kept because they stuck. Not a framework, not a product — each does one thing.

## Contents

- [cca — account switcher](#cca--account-switcher)
- [statusline](#statusline)
- [Install](#install)

## cca — account switcher

Store a [`setup-token`](https://code.claude.com/docs/en/iam#generate-a-long-lived-token) per account (encrypted in your OS keyring), then launch Claude Code as any of them. Each account runs in an isolated config dir, so switching never overwrites your primary `/login`. Needs Node ≥ 23.6 or Bun.

![](./cca/media/tui.png "cca interactive account picker")

![](./cca/media/menu.png "cca command menu")

![](./cca/media/customize.png "per-account colour, glyph, and rename")

Full docs, the interactive TUI, and the security model → **[cca/README.md](./cca/README.md)**

## statusline

Three powerline rows: context window with a live usage bar, cache and token accounting, git state, and your 5-hour / weekly rate-limit windows with reset timers. Reads Claude Code's status-line JSON on stdin; pure Python standard library, no dependencies. Needs Python 3.

![](./statusline/media/scarlet.png "statusline — default")

![](./statusline/media/tcoaal.png "statusline — tcoaal palette")

Palettes, config, and the full row breakdown → **[statusline/README.md](./statusline/README.md)**

## Install

Each tool installs independently — one line, no clone:

```
curl -fsSL https://raw.githubusercontent.com/kostenuksoft/cctk/master/cca/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/kostenuksoft/cctk/master/statusline/install.sh | sh
```

PowerShell uses `irm … | iex`; see each tool's README. Or clone and install from the checkout (keeps the source live):

```
git clone git@github.com:kostenuksoft/cctk.git
cd cctk/cca && ./install.sh          # account switcher
cd ../statusline && ./install.sh     # status line
```

Per-tool details: **[cca/README.md](./cca/README.md)** · **[statusline/README.md](./statusline/README.md)**

Personal tooling. Use it, fork it, break it — no warranty implied.
