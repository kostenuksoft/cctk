#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import NamedTuple

BAR_CELLS = 16
SIDE_PAD = 2
FALLBACK_WIDTH = 120
DEFAULT_CONTEXT_WINDOW = 200_000
GIT_TIMEOUT = 2
FIVE_HOURS = 5 * 3_600
SEVEN_DAYS = 7 * 86_400

SEPARATOR = ""
START_CAP = ""
END_CAP = ""
NBSP = " "
BAR_FULL = "█"
BAR_EMPTY = "░"
BRANCH_GLYPH = "⎇"
CLEAN_GLYPH = "✔"

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


class Segment(NamedTuple):
    fg: int
    bg: int
    text: str
    merge: bool = False


class Palette(NamedTuple):
    header: int
    accent: int
    base: int
    ink: int
    cache: int | None = None
    git: int | None = None
    weekly: int | None = None
    cached: int | None = None


def accent_for(pal: Palette, role: str) -> int:
    value = getattr(pal, role)
    return pal.accent if value is None else value


PALETTES: dict[str, Palette] = {
    "scarlet-white": Palette(header=196, accent=160, base=231, ink=16),
    "ember": Palette(header=209, accent=131, base=230, ink=236),
    "roses-in-autumn": Palette(header=125, accent=130, base=223, ink=52),
    "sakura": Palette(header=161, accent=132, base=224, ink=53),
    "tcoaal": Palette(header=124, accent=235, base=230, ink=88, cache=65, git=168, weekly=100, cached=132),
    "sadness-and-sorrow": Palette(header=67, accent=60, base=189, ink=17),
}
DEFAULT_PALETTE = "scarlet-white"


def config_dir() -> str:
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    return override if override else os.path.join(os.path.expanduser("~"), ".claude")


def config_path() -> str:
    return os.path.join(config_dir(), "statusline.json")


def read_config() -> dict[str, object]:
    try:
        with open(config_path(), encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def parse_palette(spec: object) -> Palette | None:
    if not isinstance(spec, dict):
        return None
    try:
        fields = {role: int(spec[role]) for role in ("header", "accent", "base", "ink")}
        for role in ("cache", "git", "weekly", "cached"):
            if role in spec:
                fields[role] = int(spec[role])
    except (KeyError, TypeError, ValueError):
        return None
    return Palette(**fields)


def merged_palettes(config: dict[str, object]) -> dict[str, Palette]:
    palettes = dict(PALETTES)
    defined = config.get("palettes")
    if isinstance(defined, dict):
        for name, spec in defined.items():
            palette = parse_palette(spec)
            if palette is not None:
                palettes[name] = palette
    return palettes


def resolve_palette(query: str, palettes: dict[str, Palette]) -> tuple[str | None, list[str]]:
    if query in palettes:
        return query, []
    prefix = query[:-1] if query.endswith("*") else query
    matches = [name for name in palettes if name.startswith(prefix)]
    return (matches[0], []) if len(matches) == 1 else (None, matches)


def active_name(config: dict[str, object]) -> str:
    env_choice = os.environ.get("STATUSLINE_PALETTE", "")
    if env_choice:
        return env_choice
    choice = config.get("palette")
    if isinstance(choice, str):
        return choice
    if isinstance(choice, dict):
        return "inline"
    return DEFAULT_PALETTE


def load_palette() -> Palette:
    config = read_config()
    palettes = merged_palettes(config)
    env_choice = os.environ.get("STATUSLINE_PALETTE", "")
    if env_choice in palettes:
        return palettes[env_choice]
    choice = config.get("palette")
    if isinstance(choice, dict):
        inline = parse_palette(choice)
        if inline is not None:
            return inline
    if isinstance(choice, str) and choice in palettes:
        return palettes[choice]
    return palettes[DEFAULT_PALETTE]


def sgr(*codes: int) -> str:
    return "\x1b[" + ";".join(str(code) for code in codes) + "m"


def dim(text: str) -> str:
    return f"\x1b[2m{text}\x1b[22m"


def visible_length(text: str) -> int:
    return len(_ANSI.sub("", text))


def short(count: int) -> str:
    if count < 1_000:
        return str(count)
    if count < 1_000_000:
        return f"{round(count / 1_000)}k"
    return f"{count / 1_000_000:.1f}M"


def decimal(count: int) -> str:
    if count < 1_000:
        return str(count)
    if count < 1_000_000:
        return f"{count / 1_000:.1f}k"
    return f"{count / 1_000_000:.1f}M"


def bar(fraction: float) -> str:
    filled = round(max(0.0, min(1.0, fraction)) * BAR_CELLS)
    return f"[{BAR_FULL * filled}{BAR_EMPTY * (BAR_CELLS - filled)}]"


def duration(seconds: float) -> str:
    total = max(0, int(seconds))
    days, rest = divmod(total, 86_400)
    hours, rest = divmod(rest, 3_600)
    minutes = rest // 60
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}hr")
    parts.append(f"{minutes}m")
    return " ".join(parts)


def terminal_width() -> int:
    columns = os.environ.get("COLUMNS")
    if columns and columns.isdigit():
        return int(columns)
    return shutil.get_terminal_size(fallback=(FALLBACK_WIDTH, 24)).columns


def read_stdin() -> dict[str, object]:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def section(data: dict[str, object], key: str) -> dict[str, object]:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def number(source: dict[str, object], key: str, default: float = 0.0) -> float:
    value = source.get(key)
    return float(value) if isinstance(value, (int, float)) else default


def cache_path(session_id: object) -> str:
    key = session_id if isinstance(session_id, str) and session_id else "default"
    return os.path.join(tempfile.gettempdir(), f"cc-statusline-{re.sub(r'[^A-Za-z0-9._-]', '_', key)}.json")


def load_cache(cache_file: str, path: str, size: int) -> tuple[int, int, int]:
    try:
        with open(cache_file, encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return 0, 0, 0
    if state.get("path") != path or int(state.get("offset", 0)) > size:
        return 0, 0, 0
    return int(state["offset"]), int(state["total"]), int(state["cached"])


def accumulate(chunk: bytes, offset: int) -> tuple[int, int, int]:
    boundary = chunk.rfind(b"\n") + 1
    total = cached = 0
    for raw in chunk[:boundary].splitlines():
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        message = record.get("message") if isinstance(record, dict) else None
        usage = message.get("usage") if isinstance(message, dict) else None
        if not isinstance(usage, dict):
            continue
        read = int(number(usage, "cache_read_input_tokens"))
        created = int(number(usage, "cache_creation_input_tokens"))
        total += int(number(usage, "input_tokens")) + int(number(usage, "output_tokens")) + read + created
        cached += read + created
    return offset + boundary, total, cached


def cumulative_tokens(path: object, session_id: object) -> tuple[int, int] | None:
    if not isinstance(path, str) or not path:
        return None
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    cache_file = cache_path(session_id)
    offset, total, cached = load_cache(cache_file, path, size)
    if offset < size:
        try:
            with open(path, "rb") as handle:
                handle.seek(offset)
                chunk = handle.read()
        except OSError:
            return None
        offset, added_total, added_cached = accumulate(chunk, offset)
        total += added_total
        cached += added_cached
        try:
            with open(cache_file, "w", encoding="utf-8") as handle:
                json.dump({"path": path, "offset": offset, "total": total, "cached": cached}, handle)
        except OSError:
            pass
    return total, cached


def git_status(cwd: str) -> tuple[str, str]:
    def run(*args: str) -> str:
        try:
            result = subprocess.run(
                ["git", "-C", cwd, *args],
                capture_output=True,
                text=True,
                timeout=GIT_TIMEOUT,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return result.stdout.strip()

    if run("rev-parse", "--is-inside-work-tree") != "true":
        return f"{BRANCH_GLYPH} no git", "(no git)"
    branch = run("rev-parse", "--abbrev-ref", "HEAD") or "detached"
    porcelain = run("status", "--porcelain")
    if not porcelain:
        return f"{BRANCH_GLYPH} {branch}", CLEAN_GLYPH
    added = modified = deleted = 0
    for entry in porcelain.splitlines():
        code = entry[:2]
        if "?" in code:
            added += 1
        elif code[0] in "AMR" or code[1:2] == "M":
            modified += 1
        if code[0] == "D" or code[1:2] == "D":
            deleted += 1
    return f"{BRANCH_GLYPH} {branch}", f"+{added} ~{modified} -{deleted}"


def render_group(segments: list[Segment]) -> tuple[str, int]:
    if not segments:
        return "", 0
    pieces = [sgr(38, 5, segments[0].bg) + START_CAP + sgr(39)]
    width = 1
    for index, segment in enumerate(segments):
        body = f" {segment.text} ".replace(" ", NBSP)
        pieces.append(sgr(1) + sgr(38, 5, segment.fg) + sgr(48, 5, segment.bg) + body + sgr(0))
        width += visible_length(body)
        following = segments[index + 1] if index + 1 < len(segments) else None
        if following is not None and following.bg != segment.bg and not segment.merge:
            pieces.append(sgr(38, 5, segment.bg) + sgr(48, 5, following.bg) + SEPARATOR + sgr(0))
            width += 1
    pieces.append(sgr(38, 5, segments[-1].bg) + END_CAP + sgr(0))
    return "".join(pieces), width + 1


def compose(left: list[Segment], right: list[Segment], usable: int) -> str:
    left_text, left_width = render_group(left)
    right_text, right_width = render_group(right)
    pad = NBSP * SIDE_PAD
    gap = max(1, usable - 2 * SIDE_PAD - left_width - right_width)
    return pad + left_text + NBSP * gap + right_text + pad


def next_reset(resets_at: float, period: int, now: float) -> float:
    remaining = resets_at - now
    if remaining <= 0 and period:
        remaining += (int(now - resets_at) // period + 1) * period
    return remaining


def rate_segments(window: dict[str, object], label: str, accent: int, now: float, period: int, pal: Palette) -> list[Segment]:
    if not window:
        return [Segment(pal.base, accent, f"{label}: n/a")]
    used = number(window, "used_percentage")
    segments = [Segment(pal.base, accent, f"{label}: {bar(used / 100)} {used:.1f}%")]
    resets_at = window.get("resets_at")
    if isinstance(resets_at, (int, float)):
        segments.append(Segment(pal.ink, pal.base, duration(next_reset(resets_at, period, now))))
    return segments


def build_lines(data: dict[str, object], pal: Palette) -> list[str]:
    now = time.time()
    model = str(section(data, "model").get("display_name", "Claude"))
    workspace = section(data, "workspace")
    cwd = str(workspace.get("current_dir") or data.get("cwd") or os.getcwd())

    context = section(data, "context_window")
    usage = section(context, "current_usage")
    input_tokens = int(number(usage, "input_tokens"))
    created = int(number(usage, "cache_creation_input_tokens"))
    read = int(number(usage, "cache_read_input_tokens"))
    window_size = int(number(context, "context_window_size", DEFAULT_CONTEXT_WINDOW)) or DEFAULT_CONTEXT_WINDOW
    context_length = int(number(context, "total_input_tokens", input_tokens + created + read))
    used_percentage = number(context, "used_percentage", context_length / window_size * 100 if window_size else 0.0)
    input_total = input_tokens + created + read
    hit_rate = read / input_total * 100 if input_total else 0.0

    totals = cumulative_tokens(data.get("transcript_path"), data.get("session_id"))
    total_tokens, cached_tokens = totals if totals is not None else (context_length, created + read)

    limits = section(data, "rate_limits")
    branch_text, change_text = git_status(cwd)

    first_line = [
        Segment(pal.base, pal.header, model),
        Segment(
            pal.ink,
            pal.base,
            f"{bar(used_percentage / 100)} {short(context_length)}/{short(window_size)} {dim(f'({used_percentage:.0f}%)')}",
        ),
    ]
    effort = section(data, "effort").get("level")
    if isinstance(effort, str) and effort:
        first_line.append(Segment(pal.accent, pal.base, effort))

    second_left = [
        Segment(pal.base, accent_for(pal, "cache"), f"Cache Hit: {hit_rate:.1f}%"),
        Segment(pal.ink, pal.base, f"Cache Read: {decimal(read)}"),
        Segment(pal.ink, pal.base, f"Cache Write: {decimal(created)}"),
    ]
    third_left = [
        Segment(pal.base, accent_for(pal, "git"), branch_text),
        Segment(pal.ink, pal.base, change_text),
    ]
    third_right = [
        Segment(pal.base, accent_for(pal, "cached"), f"Cached: {decimal(cached_tokens)}", merge=True),
        Segment(pal.base, accent_for(pal, "cached"), f"Total: {decimal(total_tokens)}"),
        Segment(pal.ink, pal.base, f"Ctx: {decimal(context_length)}"),
    ]

    usable = max(20, terminal_width())
    return [
        compose(first_line, rate_segments(section(limits, "five_hour"), "Session", pal.header, now, FIVE_HOURS, pal), usable),
        compose(second_left, rate_segments(section(limits, "seven_day"), "Weekly", accent_for(pal, "weekly"), now, SEVEN_DAYS, pal), usable),
        compose(third_left, third_right, usable),
    ]


def run_command(args: list[str]) -> int:
    config = read_config()
    palettes = merged_palettes(config)
    command = args[0]
    if command == "palettes":
        active = active_name(config)
        for name in palettes:
            sys.stdout.write(f"{'*' if name == active else ' '} {name}\n")
        return 0
    if command == "palette":
        if len(args) < 2:
            sys.stdout.write(f"{active_name(config)}\n")
            return 0
        resolved, matches = resolve_palette(args[1], palettes)
        if resolved is None:
            if matches:
                sys.stderr.write(f"ambiguous palette '{args[1]}' — matches: {', '.join(matches)}\n")
            else:
                sys.stderr.write(f"unknown palette: {args[1]} (see: statusline.py palettes)\n")
            return 1
        config["palette"] = resolved
        try:
            with open(config_path(), "w", encoding="utf-8") as handle:
                json.dump(config, handle, indent=2)
                handle.write("\n")
        except OSError as error:
            sys.stderr.write(f"could not write {config_path()}: {error}\n")
            return 1
        sys.stdout.write(f"palette set to {resolved}\n")
        return 0
    sys.stderr.write("usage: statusline.py [palettes | palette [name]]\n")
    return 1


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) > 1:
        raise SystemExit(run_command(sys.argv[1:]))
    sys.stdout.write("\n".join(build_lines(read_stdin(), load_palette())))


if __name__ == "__main__":
    main()
