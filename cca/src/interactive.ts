import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { UserFacingError, isAccountName, readIndex, readMeta, readSettings, readStatusCache, readVersion, setMeta, writeSettings, type AccountMeta } from "./core.ts";
import { accent, banner, bold, clay, cream, ember, MASK, mute, sage, swatch, GLYPHS, PALETTE, type Rgb } from "./theme.ts";
import { type TokenStatus } from "./validate.ts";
import { readIdentity, type AccountIdentity } from "./identity.ts";
import { accountRows, addAccount, applyImport, buildExport, launchStatus, parseBundle, removeAccount, renameAccount, statusLabel, verifyAccount } from "./accounts.ts";
import { seal, unseal, parseSealed } from "./crypt.ts";
import { detectStore } from "./secrets/store.ts";
import { sanitizeTyped } from "./input.ts";
import { formatPipeline, parsePipeline } from "./pipeline.ts";

export interface InteractiveDeps {
  readonly launch: (name: string, args: string[]) => Promise<never>;
}

type CommandResult = "quit" | void;

type LoopSignal = "launch" | "quit" | undefined;

interface ViewHandler {
  readonly render: (state: State) => string[];
  readonly onKey: (state: State, key: Key, paint: () => void) => LoopSignal | Promise<LoopSignal>;
}

interface MenuItem {
  readonly name: string;
  readonly summary: string;
  readonly run: (state: State, arg: string | undefined, paint: () => void) => CommandResult | Promise<CommandResult>;
}

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const CTRL_P = String.fromCharCode(16);
const CTRL_N = String.fromCharCode(14);
const DEL = String.fromCharCode(127);
const TAB = "\t";

type Nav = "enter" | "escape" | "up" | "down" | "left" | "right" | "backspace" | "tab" | "interrupt" | "none";

const NAV_KEYS: readonly (readonly [Exclude<Nav, "none">, ReadonlySet<string>])[] = [
  ["interrupt", new Set([CTRL_C])],
  ["enter", new Set(["\r", "\n"])],
  ["escape", new Set([ESC])],
  ["tab", new Set([TAB])],
  ["backspace", new Set([DEL, "\b"])],
  ["up", new Set([`${ESC}[A`, `${ESC}OA`, CTRL_P])],
  ["down", new Set([`${ESC}[B`, `${ESC}OB`, CTRL_N])],
  ["right", new Set([`${ESC}[C`, `${ESC}OC`])],
  ["left", new Set([`${ESC}[D`, `${ESC}OD`])],
];

interface Key {
  readonly nav: Nav;
  readonly text: string;
}

const ENTER_ALT = `${ESC}[?1049h`;
const EXIT_ALT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const HOME = `${ESC}[H`;
const CLEAR_EOL = `${ESC}[K`;
const CLEAR_BELOW = `${ESC}[0J`;

const TOP_PADDING = 1;
const LIST_OVERHEAD = 11;
const CARET = mute("▏");
const INDENT = "  ";
const SEPARATOR = mute("─".repeat(44));
const VERSION = readVersion();

const MENU: readonly MenuItem[] = [
  {
    name: "add",
    summary: "add a new account (paste a setup-token)",
    run: (state, arg) => {
      beginAdd(state, arg);
    },
  },
  {
    name: "check",
    summary: "verify stored tokens against the API",
    run: async (state, arg, paint) => {
      await runCheck(state, arg, paint);
      state.view = "list";
    },
  },
  {
    name: "customize",
    summary: "colour, glyph, or rename the selected account",
    run: (state, arg) => {
      openCustomize(state, arg);
    },
  },
  {
    name: "remove",
    summary: "forget the selected account",
    run: (state, arg) => {
      beginRemove(state, arg);
    },
  },
  {
    name: "settings",
    summary: "general settings",
    run: (state) => {
      openSettings(state);
    },
  },
  {
    name: "pipeline",
    summary: "flags applied to picker launches",
    run: (state) => {
      openPipeline(state);
    },
  },
  {
    name: "export",
    summary: "encrypt accounts to a file (passphrase)",
    run: (state) => {
      openExport(state);
    },
  },
  {
    name: "import",
    summary: "restore accounts from an encrypted export",
    run: (state) => {
      openImport(state);
    },
  },
  {
    name: "help",
    summary: "keyboard shortcuts",
    run: (state) => {
      state.view = "help";
    },
  },
  {
    name: "quit",
    summary: "exit cca",
    run: () => "quit",
  },
];

function readKey(chunk: string): Key {
  for (const [nav, keys] of NAV_KEYS) {
    if (keys.has(chunk)) {
      return { nav, text: "" };
    }
  }
  return { nav: "none", text: sanitizeTyped(chunk) };
}

class KeyReader {
  private readonly queue: string[] = [];
  private waiter: ((key: string) => void) | undefined;

  constructor() {
    input.on("data", this.onData);
  }

  private readonly onData = (chunk: string): void => {
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(chunk);
      return;
    }
    this.queue.push(chunk);
  };

  next(): Promise<string> {
    const pending = this.queue.shift();
    if (pending !== undefined) {
      return Promise.resolve(pending);
    }
    return new Promise<string>((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    input.removeListener("data", this.onData);
  }
}

interface State {
  view: "list" | "menu" | "help" | "add" | "confirm" | "detail" | "customize" | "settings" | "export" | "import" | "pipeline";
  names: string[];
  cursor: number;
  notice: string;
  buffer: string;
  menuCursor: number;
  addName: string;
  addToken: string;
  addStage: "name" | "token";
  confirmName: string;
  armed: string;
  quitArmed: boolean;
  detailRows: string[];
  closing: boolean;
  customName: string;
  customStage: "menu" | "color" | "rename";
  customCursor: number;
  pendingColor: Rgb | undefined;
  pendingGlyph: string | undefined;
  editBuffer: string;
  settingsValidate: boolean;
  pipeline: string;
  ioStage: "file" | "pass";
  ioFile: string;
  readonly statuses: Map<string, TokenStatus>;
  readonly identities: Map<string, AccountIdentity>;
  meta: Record<string, AccountMeta>;
}

const GLYPH_OPTIONS: readonly (string | undefined)[] = [undefined, ...GLYPHS];
const COLOR_OPTIONS: readonly (Rgb | undefined)[] = [undefined, ...PALETTE];

function cycle<T>(options: readonly T[], current: T, delta: number, eq: (a: T, b: T) => boolean): T {
  const index = options.findIndex((option) => eq(option, current));
  const next = (index + delta + options.length) % options.length;
  return options[next] ?? current;
}

function sameColor(a: Rgb | undefined, b: Rgb | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function loadIdentities(names: string[]): Map<string, AccountIdentity> {
  const map = new Map<string, AccountIdentity>();
  for (const name of names) {
    const identity = readIdentity(name);
    if (identity !== undefined) {
      map.set(name, identity);
    }
  }
  return map;
}

function selected(state: State): string | undefined {
  return state.names[state.cursor];
}

function commandWord(buffer: string): string {
  return buffer.slice(1).split(/\s+/, 1)[0] ?? "";
}

function commandArg(buffer: string): string | undefined {
  const rest = buffer.slice(1 + commandWord(buffer).length).trim();
  return rest.length > 0 ? rest : undefined;
}

function filterMenu(buffer: string): MenuItem[] {
  const word = commandWord(buffer);
  return MENU.filter((item) => item.name.startsWith(word));
}

function step(delta: number, length: number, current: number): number {
  return length === 0 ? 0 : (current + delta + length) % length;
}

function line(text: string): string {
  return `${INDENT}${text}`;
}

function footer(text: string): string {
  return line(mute(text));
}

function noticeLine(state: State): string {
  return state.notice === "" ? "" : line(state.notice);
}

function listWindow(total: number, cursor: number, capacity: number): readonly [number, number] {
  if (total <= capacity) {
    return [0, total];
  }
  const start = Math.min(Math.max(0, cursor - Math.floor(capacity / 2)), total - capacity);
  return [start, start + capacity];
}

function listBody(state: State): string[] {
  const command = line(`${mute("› press ")}${cream("/")}${mute(" for commands")}`);
  const flags = formatPipeline(parsePipeline(state.pipeline));
  const launchLine = line(flags === "" ? mute("launch: fresh session · /pipeline to add flags") : `${mute("launch:")} ${cream(`claude ${flags}`)}`);
  const trailer = ["", launchLine, noticeLine(state), command, footer("↑↓ select · enter launch · i info · c customize · q quit")];
  if (state.names.length === 0) {
    return [line(`${mute("no accounts yet — press ")}${cream("/")}${mute(" then ")}${cream("add")}`), ...trailer];
  }
  const capacity = Math.max(3, (output.rows ?? 24) - LIST_OVERHEAD);
  const [start, end] = listWindow(state.names.length, state.cursor, capacity);
  const width = Math.max(...state.names.map((name) => name.length));
  const emails = state.names.map((name) => {
    const identity = state.identities.get(name);
    return identity === undefined ? "" : identity.email || identity.displayName;
  });
  const emailWidth = Math.max(0, ...emails.map((email) => email.length));
  const rows: string[] = [];
  if (start > 0) {
    rows.push(footer(`↑ ${start} more`));
  }
  for (let index = start; index < end; index++) {
    const name = state.names[index];
    if (name === undefined) {
      continue;
    }
    const pointer = index === state.cursor ? clay("❯ ") : INDENT;
    const shown = name.padEnd(width);
    const entry = state.meta[name];
    const nameText = index === state.cursor ? bold(accent(name, entry?.color, shown)) : accent(name, entry?.color, shown);
    const who = emailWidth === 0 ? "" : `  ${mute((emails[index] ?? "").padEnd(emailWidth))}`;
    const label = statusLabel(state.statuses.get(name));
    rows.push(`${pointer}${swatch(name, entry?.color, entry?.glyph)} ${nameText}${who}${label === "" ? "" : `  ${label}`}`);
  }
  if (end < state.names.length) {
    rows.push(footer(`↓ ${state.names.length - end} more`));
  }
  return [...rows, ...trailer];
}

function detailBody(state: State): string[] {
  return [...state.detailRows, "", footer("esc back")];
}

function enterDetail(state: State): void {
  const name = selected(state);
  if (name === undefined) {
    return;
  }
  const identity = state.identities.get(name);
  const status = statusLabel(state.statuses.get(name));
  const entry = state.meta[name];
  const rows = accountRows(name, status === "" ? mute("not checked") : status, identity, detectStore().read(name));
  const width = Math.max(...rows.map(([label]) => label.length));
  state.detailRows = [
    line(`${swatch(name, entry?.color, entry?.glyph)} ${bold(accent(name, entry?.color, name))}`),
    "",
    ...rows.map(([label, value]) => line(`${mute(label.padEnd(width))}  ${value}`)),
  ];
  state.view = "detail";
}

function parseRgb(text: string): Rgb | undefined {
  const parts = text.split(/[^0-9]+/).filter((part) => part !== "");
  if (parts.length !== 3) {
    return undefined;
  }
  const rgb = parts.map(Number);
  if (rgb.some((value) => value > 255)) {
    return undefined;
  }
  return [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0];
}

function openCustomize(state: State, arg: string | undefined): void {
  const name = arg ?? selected(state);
  if (name === undefined || !state.names.includes(name)) {
    state.notice = ember(arg === undefined ? "no account selected." : `no such account: ${arg}`);
    return;
  }
  const entry = state.meta[name];
  state.customName = name;
  state.pendingColor = entry?.color;
  state.pendingGlyph = entry?.glyph;
  state.customStage = "menu";
  state.customCursor = 0;
  state.editBuffer = "";
  state.notice = "";
  state.view = "customize";
}

function persistMeta(state: State): void {
  setMeta(state.customName, { color: state.pendingColor, glyph: state.pendingGlyph });
  state.meta = readMeta();
}

function customizeBody(state: State): string[] {
  const name = state.customName;
  const preview = `${swatch(name, state.pendingColor, state.pendingGlyph)} ${bold(accent(name, state.pendingColor, name))}`;
  const glyphValue = swatch(name, state.pendingColor, state.pendingGlyph);
  const colorValue =
    state.customStage === "color"
      ? `${cream(state.editBuffer)}${CARET} ${mute("r g b")}`
      : state.pendingColor === undefined
        ? mute("default")
        : `${swatch(name, state.pendingColor, undefined)} ${mute(state.pendingColor.join(" "))}`;
  const renameValue = state.customStage === "rename" ? `${cream(state.editBuffer)}${CARET}` : cream(name);
  const fields: Array<readonly [string, string]> = [
    ["glyph", glyphValue],
    ["color", colorValue],
    ["rename", renameValue],
  ];
  const rows = fields.map(([label, value], index) => {
    const active = state.customStage === "menu" && index === state.customCursor;
    const pointer = active ? clay("❯ ") : INDENT;
    return `${pointer}${(active ? cream : mute)(label.padEnd(6))}  ${value}`;
  });
  const footerText =
    state.customStage === "color"
      ? "type r g b · enter save · esc cancel"
      : state.customStage === "rename"
        ? "type new name · enter save · esc cancel"
        : "↑↓ field · ← → change · enter edit · r reset · esc back";
  return [line(preview), "", ...rows, "", noticeLine(state), footer(footerText)];
}

function onCustomizeKey(state: State, key: Key): LoopSignal {
  if (state.customStage === "color") {
    if (key.nav === "escape") {
      state.pendingColor = state.meta[state.customName]?.color;
      state.customStage = "menu";
      state.editBuffer = "";
      return undefined;
    }
    if (key.nav === "enter") {
      const rgb = parseRgb(state.editBuffer);
      if (rgb === undefined) {
        state.notice = ember("enter three values 0–255");
        return undefined;
      }
      state.pendingColor = rgb;
      persistMeta(state);
      state.customStage = "menu";
      state.editBuffer = "";
      state.notice = "";
      return undefined;
    }
    state.editBuffer = key.nav === "backspace" ? state.editBuffer.slice(0, -1) : state.editBuffer + key.text;
    const live = parseRgb(state.editBuffer);
    if (live !== undefined) {
      state.pendingColor = live;
    }
    return undefined;
  }
  if (state.customStage === "rename") {
    if (key.nav === "escape") {
      state.customStage = "menu";
      state.editBuffer = "";
      return undefined;
    }
    if (key.nav === "enter") {
      const target = state.editBuffer.trim();
      if (!isAccountName(target)) {
        state.notice = ember("invalid name (letters, digits, . _ -)");
        return undefined;
      }
      if (target === state.customName) {
        state.customStage = "menu";
        state.editBuffer = "";
        return undefined;
      }
      if (state.names.includes(target)) {
        state.notice = ember(`name already used: ${target}`);
        return undefined;
      }
      renameAccount(state.customName, target);
      const status = state.statuses.get(state.customName);
      state.statuses.delete(state.customName);
      if (status !== undefined) {
        state.statuses.set(target, status);
      }
      const identity = state.identities.get(state.customName);
      state.identities.delete(state.customName);
      if (identity !== undefined) {
        state.identities.set(target, identity);
      }
      state.names = readIndex();
      state.meta = readMeta();
      state.cursor = Math.max(0, state.names.indexOf(target));
      state.notice = mute(`renamed to ${target}.`);
      state.view = "list";
      return undefined;
    }
    state.editBuffer = key.nav === "backspace" ? state.editBuffer.slice(0, -1) : state.editBuffer + key.text;
    return undefined;
  }
  if (key.nav === "escape") {
    state.view = "list";
    state.notice = "";
    return undefined;
  }
  if (key.text === "r") {
    state.pendingColor = undefined;
    state.pendingGlyph = undefined;
    persistMeta(state);
    state.notice = mute("reset to defaults");
    return undefined;
  }
  if (key.nav === "up") {
    state.customCursor = step(-1, 3, state.customCursor);
    return undefined;
  }
  if (key.nav === "down") {
    state.customCursor = step(1, 3, state.customCursor);
    return undefined;
  }
  if (state.customCursor === 0 && (key.nav === "left" || key.nav === "right")) {
    state.pendingGlyph = cycle(GLYPH_OPTIONS, state.pendingGlyph, key.nav === "right" ? 1 : -1, (a, b) => a === b);
    persistMeta(state);
    return undefined;
  }
  if (state.customCursor === 1 && (key.nav === "left" || key.nav === "right")) {
    state.pendingColor = cycle(COLOR_OPTIONS, state.pendingColor, key.nav === "right" ? 1 : -1, sameColor);
    persistMeta(state);
    return undefined;
  }
  if (key.nav === "enter" && state.customCursor === 1) {
    state.customStage = "color";
    state.editBuffer = "";
  } else if (key.nav === "enter" && state.customCursor === 2) {
    state.customStage = "rename";
    state.editBuffer = "";
  }
  return undefined;
}

function openSettings(state: State): void {
  state.settingsValidate = readSettings().validateOnLaunch;
  state.notice = "";
  state.view = "settings";
}

function openPipeline(state: State): void {
  state.pipeline = readSettings().pipeline;
  state.editBuffer = formatPipeline(parsePipeline(state.pipeline));
  state.notice = "";
  state.view = "pipeline";
}

function pipelineBody(state: State): string[] {
  return [
    line(mute("flags applied when you launch an account from the picker")),
    "",
    line(`${mute("flags:")} ${cream(state.editBuffer)}${CARET}`),
    "",
    line(mute("e.g. ") + cream("--continue") + mute(" resumes this folder's latest chat as the account")),
    "",
    noticeLine(state),
    footer("enter save · esc cancel"),
  ];
}

function onPipelineKey(state: State, key: Key): LoopSignal {
  if (key.nav === "escape") {
    state.view = "list";
    state.notice = "";
    return undefined;
  }
  if (key.nav === "enter") {
    const value = state.editBuffer.trim();
    writeSettings({ pipeline: value });
    state.pipeline = value;
    state.notice = value === "" ? mute("pipeline cleared — fresh launches") : sage(`pipeline saved: ${value}`);
    state.view = "list";
    return undefined;
  }
  state.editBuffer = key.nav === "backspace" ? state.editBuffer.slice(0, -1) : state.editBuffer + key.text;
  return undefined;
}

const DEFAULT_EXPORT_NAME = "cca-export.json";

function defaultExportPath(): string {
  return join(homedir(), DEFAULT_EXPORT_NAME);
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function beginFileEntry(state: State, view: State["view"]): void {
  state.ioStage = "file";
  state.editBuffer = defaultExportPath();
  state.notice = "";
  state.view = view;
}

function takeFilePath(state: State): string | undefined {
  const path = expandHome(state.editBuffer.trim());
  if (path === "") {
    state.notice = ember("enter a file path");
    return undefined;
  }
  return path;
}

function backToFileStage(state: State): void {
  state.ioStage = "file";
  state.editBuffer = state.ioFile;
  state.notice = "";
}

function openExport(state: State): void {
  if (readIndex().length === 0) {
    state.notice = ember("no accounts to export");
    return;
  }
  beginFileEntry(state, "export");
}

function exportBody(state: State): string[] {
  if (state.ioStage === "file") {
    return [
      line(`${mute("encrypt")} ${cream(String(readIndex().length))} ${mute("account(s) to file:")}`),
      "",
      line(`${cream(state.editBuffer)}${CARET}`),
      "",
      noticeLine(state),
      footer("enter next · esc cancel"),
    ];
  }
  return [
    line(`${mute("encrypt to")} ${cream(state.ioFile)}`),
    "",
    line(`${mute("passphrase:")} ${mute(MASK.repeat(state.editBuffer.length))}${CARET}`),
    "",
    noticeLine(state),
    footer("enter encrypt & save · esc back"),
  ];
}

function onExportKey(state: State, key: Key): LoopSignal {
  if (key.nav === "escape") {
    if (state.ioStage === "pass") {
      backToFileStage(state);
      return undefined;
    }
    state.view = "list";
    state.notice = "";
    return undefined;
  }
  if (key.nav === "enter") {
    if (state.ioStage === "file") {
      const path = takeFilePath(state);
      if (path === undefined) {
        return undefined;
      }
      state.ioFile = path;
      state.ioStage = "pass";
      state.editBuffer = "";
      state.notice = "";
      return undefined;
    }
    if (state.editBuffer === "") {
      state.notice = ember("no passphrase entered");
      return undefined;
    }
    fs.writeFileSync(state.ioFile, `${JSON.stringify(seal(JSON.stringify(buildExport()), state.editBuffer), null, 2)}\n`, { mode: 0o600 });
    state.editBuffer = "";
    state.notice = sage(`exported (encrypted) to ${state.ioFile}`);
    state.view = "list";
    return undefined;
  }
  state.editBuffer = key.nav === "backspace" ? state.editBuffer.slice(0, -1) : state.editBuffer + key.text;
  return undefined;
}

function openImport(state: State): void {
  beginFileEntry(state, "import");
}

function importBody(state: State): string[] {
  if (state.ioStage === "file") {
    return [
      line(mute("restore accounts from file:")),
      "",
      line(`${cream(state.editBuffer)}${CARET}`),
      "",
      noticeLine(state),
      footer("enter next · esc cancel"),
    ];
  }
  return [
    line(`${mute("restore from")} ${cream(state.ioFile)}`),
    "",
    line(`${mute("passphrase:")} ${mute(MASK.repeat(state.editBuffer.length))}${CARET}`),
    "",
    noticeLine(state),
    footer("enter decrypt & import · esc back"),
  ];
}

function onImportKey(state: State, key: Key): LoopSignal {
  if (key.nav === "escape") {
    if (state.ioStage === "pass") {
      backToFileStage(state);
      return undefined;
    }
    state.view = "list";
    state.notice = "";
    return undefined;
  }
  if (key.nav === "enter") {
    if (state.ioStage === "file") {
      const path = takeFilePath(state);
      if (path === undefined) {
        return undefined;
      }
      if (!fs.existsSync(path)) {
        state.notice = ember(`no such file: ${path}`);
        return undefined;
      }
      state.ioFile = path;
      state.ioStage = "pass";
      state.editBuffer = "";
      state.notice = "";
      return undefined;
    }
    if (state.editBuffer === "") {
      state.notice = ember("no passphrase entered");
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(state.ioFile, "utf8"));
    } catch {
      state.notice = ember("export file is not valid JSON");
      return undefined;
    }
    const sealed = parseSealed(parsed);
    if (sealed === undefined) {
      state.notice = ember("not a cca export file");
      return undefined;
    }
    let json: string;
    try {
      json = unseal(sealed, state.editBuffer);
    } catch {
      state.notice = ember("wrong passphrase, or the file was tampered with");
      return undefined;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(json);
    } catch {
      state.notice = ember("the export file is corrupt");
      return undefined;
    }
    const added = applyImport(parseBundle(decoded));
    state.names = readIndex();
    state.meta = readMeta();
    for (const name of added) {
      const identity = readIdentity(name);
      if (identity !== undefined) {
        state.identities.set(name, identity);
      }
    }
    state.editBuffer = "";
    state.cursor = Math.min(state.cursor, Math.max(0, state.names.length - 1));
    state.notice = added.length === 0 ? mute("no accounts to import") : sage(`imported ${String(added.length)} account${added.length === 1 ? "" : "s"}`);
    state.view = "list";
    return undefined;
  }
  state.editBuffer = key.nav === "backspace" ? state.editBuffer.slice(0, -1) : state.editBuffer + key.text;
  return undefined;
}

function settingsBody(state: State): string[] {
  const on = state.settingsValidate;
  const value = `${on ? bold(cream("[on]")) : mute("on")}  ${on ? mute("off") : bold(cream("[off]"))}`;
  return [
    line(mute("validate the account's token once, right before launch")),
    "",
    line(`  ${cream("validate on launch")}   ${value}`),
    "",
    noticeLine(state),
    footer("← → toggle · esc back"),
  ];
}

function onSettingsKey(state: State, key: Key): LoopSignal {
  if (key.nav === "escape" || key.nav === "enter") {
    state.view = "list";
    return undefined;
  }
  if (key.nav === "left" || key.nav === "right") {
    state.settingsValidate = !state.settingsValidate;
    writeSettings({ validateOnLaunch: state.settingsValidate });
  }
  return undefined;
}

function menuBody(state: State): string[] {
  const list = filterMenu(state.buffer);
  const rows: string[] = [line(`${clay(state.buffer)}${CARET}`), ""];
  if (list.length === 0) {
    rows.push(line(mute("no matching command")));
  } else {
    const width = Math.max(...list.map((item) => item.name.length + 1));
    list.forEach((item, index) => {
      const pointer = index === state.menuCursor ? clay("❯ ") : INDENT;
      const usage = `/${item.name}`.padEnd(width);
      rows.push(`${pointer}${index === state.menuCursor ? bold(cream(usage)) : cream(usage)}  ${mute(item.summary)}`);
    });
  }
  return [...rows, "", noticeLine(state), footer("↑↓ move · tab complete · enter run · esc back")];
}

const KEYS: readonly (readonly [string, string])[] = [
  ["↑ ↓  j k", "move selection"],
  ["1–9", "jump to account"],
  ["enter enter", "launch selected account"],
  ["i", "account info"],
  ["c", "customize (colour, glyph, rename)"],
  ["/", "command menu"],
  ["esc", "back"],
  ["q  ctrl-c", "quit"],
];

function helpBody(): string[] {
  const width = Math.max(...KEYS.map(([keys]) => keys.length));
  const rows = KEYS.map(([keys, desc]) => line(`${clay(keys.padEnd(width))}   ${mute(desc)}`));
  return [...rows, "", line(`${mute("questions or issues:")} ${cream("github.com/kostenuksoft/cctk")}`), "", footer("esc back · / for commands")];
}

function addBody(state: State): string[] {
  if (state.addStage === "name") {
    return [
      line(`${mute("new account name:")} ${cream(state.addName)}${CARET}`),
      "",
      noticeLine(state),
      footer("enter next · esc cancel"),
    ];
  }
  return [
    line(`${mute("account:")} ${cream(state.addName)}`),
    line(`${mute("paste token:")} ${mute(MASK.repeat(state.addToken.length))}${CARET}`),
    "",
    noticeLine(state),
    footer("run 'claude setup-token' first · enter store · esc cancel"),
  ];
}

function confirmBody(state: State): string[] {
  return [line(`${mute("remove")} ${cream(state.confirmName)}${mute("?")}`), "", footer("enter / y remove · n / esc keep")];
}

const VIEWS: Record<State["view"], ViewHandler> = {
  list: { render: listBody, onKey: onListKey },
  menu: { render: menuBody, onKey: onMenuKey },
  help: { render: helpBody, onKey: onBackKey },
  add: { render: addBody, onKey: onAddKey },
  confirm: { render: confirmBody, onKey: onConfirmKey },
  detail: { render: detailBody, onKey: onBackKey },
  customize: { render: customizeBody, onKey: onCustomizeKey },
  settings: { render: settingsBody, onKey: onSettingsKey },
  export: { render: exportBody, onKey: onExportKey },
  import: { render: importBody, onKey: onImportKey },
  pipeline: { render: pipelineBody, onKey: onPipelineKey },
};

function render(state: State): void {
  const header = banner().split("\n");
  header[0] = `${header[0] ?? ""}  ${mute("v" + VERSION)}`;
  const lines = [
    ...Array.from({ length: TOP_PADDING }, () => ""),
    ...header,
    SEPARATOR,
    ...VIEWS[state.view].render(state),
  ];
  const body = lines.map((text) => `${text}${CLEAR_EOL}`).join("\n");
  output.write(`${HOME}${body}${CLEAR_BELOW}`);
}

async function runCheck(state: State, arg: string | undefined, paint: () => void): Promise<void> {
  const targets = arg === undefined ? state.names : state.names.filter((name) => name === arg);
  if (targets.length === 0) {
    state.notice = arg === undefined ? mute("no accounts to check.") : ember(`no such account: ${arg}`);
    return;
  }
  for (const [index, name] of targets.entries()) {
    state.notice = mute(`checking ${name}… (${String(index)}/${String(targets.length)})`);
    paint();
    state.statuses.set(name, await verifyAccount(name));
  }
  state.notice = mute(`checked ${String(targets.length)} account${targets.length === 1 ? "" : "s"}.`);
}

async function storeToken(state: State, paint: () => void): Promise<void> {
  const token = state.addToken.trim();
  if (token === "") {
    state.notice = ember("no token entered.");
    return;
  }
  state.notice = mute("validating…");
  paint();
  const { status, existed } = await addAccount(state.addName, token);
  if (status.kind === "invalid") {
    state.notice = ember(`token rejected (HTTP ${String(status.status)}) — not stored.`);
    return;
  }
  state.statuses.set(state.addName, status);
  const identity = readIdentity(state.addName);
  if (identity !== undefined) {
    state.identities.set(state.addName, identity);
  }
  state.names = readIndex();
  state.cursor = state.names.indexOf(state.addName);
  state.notice =
    status.kind === "valid"
      ? sage(`${existed ? "updated" : "added"} ${state.addName}.`)
      : mute(`stored ${state.addName} (unverified: ${status.reason}).`);
}

function beginAdd(state: State, arg: string | undefined): void {
  state.view = "add";
  state.addToken = "";
  const named = arg !== undefined && isAccountName(arg);
  state.addName = named ? arg : "";
  state.addStage = named ? "token" : "name";
}

function beginRemove(state: State, arg: string | undefined): void {
  const target = arg ?? selected(state);
  if (target === undefined || !state.names.includes(target)) {
    state.view = "list";
    state.notice = ember(arg === undefined ? "no account selected." : `no such account: ${arg}`);
    return;
  }
  state.confirmName = target;
  state.view = "confirm";
}

function onListKey(state: State, key: Key): LoopSignal {
  const armed = state.armed;
  const quitArmed = state.quitArmed;
  state.armed = "";
  state.quitArmed = false;
  state.notice = "";
  if (key.text === "/") {
    state.view = "menu";
    state.buffer = "/";
    state.menuCursor = 0;
    return undefined;
  }
  if (key.nav === "escape" || key.text === "q") {
    if (quitArmed) {
      return "quit";
    }
    state.quitArmed = true;
    state.notice = mute("press esc or q again to quit");
    return undefined;
  }
  if (key.nav === "up" || key.text === "k") {
    state.cursor = step(-1, state.names.length, state.cursor);
    return undefined;
  }
  if (key.nav === "down" || key.text === "j") {
    state.cursor = step(1, state.names.length, state.cursor);
    return undefined;
  }
  if (/^[1-9]$/.test(key.text)) {
    const index = Number(key.text) - 1;
    if (index < state.names.length) {
      state.cursor = index;
    }
    return undefined;
  }
  if (key.text === "i") {
    enterDetail(state);
    return undefined;
  }
  if (key.text === "c") {
    openCustomize(state, undefined);
    return undefined;
  }
  if (key.nav === "enter") {
    const name = selected(state);
    if (name === undefined) {
      return undefined;
    }
    if (armed === name) {
      return "launch";
    }
    state.armed = name;
    state.notice = mute(`press enter again to launch ${cream(name)}`);
  }
  return undefined;
}

async function onMenuKey(state: State, key: Key, paint: () => void): Promise<LoopSignal> {
  if (key.nav === "escape") {
    state.view = "list";
    return undefined;
  }
  const list = filterMenu(state.buffer);
  const highlighted = list[state.menuCursor];
  if (key.nav === "enter") {
    if (highlighted === undefined) {
      state.notice = ember(`unknown command: ${state.buffer}`);
      return undefined;
    }
    state.notice = "";
    return (await highlighted.run(state, commandArg(state.buffer), paint)) === "quit" ? "quit" : undefined;
  }
  if (key.nav === "tab" && highlighted !== undefined) {
    state.buffer = `/${highlighted.name} `;
    state.menuCursor = 0;
    return undefined;
  }
  if (key.nav === "up") {
    state.menuCursor = step(-1, list.length, state.menuCursor);
    return undefined;
  }
  if (key.nav === "down") {
    state.menuCursor = step(1, list.length, state.menuCursor);
    return undefined;
  }
  if (key.nav === "backspace") {
    state.buffer = state.buffer.slice(0, -1);
    state.menuCursor = 0;
    if (state.buffer === "") {
      state.view = "list";
    }
    return undefined;
  }
  if (key.text !== "") {
    state.buffer += key.text;
    state.menuCursor = 0;
  }
  return undefined;
}

async function onAddKey(state: State, key: Key, paint: () => void): Promise<LoopSignal> {
  if (key.nav === "escape") {
    state.view = "list";
    state.notice = "";
    return;
  }
  const field = state.addStage === "name" ? "addName" : "addToken";
  if (key.nav === "backspace") {
    state[field] = state[field].slice(0, -1);
    return;
  }
  if (key.nav !== "enter") {
    state[field] += key.text;
    return;
  }
  if (state.addStage === "name") {
    if (!isAccountName(state.addName)) {
      state.notice = ember("invalid name (use letters, digits, . _ -).");
      return;
    }
    state.addStage = "token";
    state.notice = "";
    return;
  }
  if (state.addToken === "") {
    state.notice = ember("no token entered.");
    return;
  }
  await storeToken(state, paint);
  state.view = "list";
}

function onConfirmKey(state: State, key: Key): LoopSignal {
  if (key.text.toLowerCase() === "y" || key.nav === "enter") {
    removeAccount(state.confirmName);
    state.statuses.delete(state.confirmName);
    state.identities.delete(state.confirmName);
    delete state.meta[state.confirmName];
    state.names = readIndex();
    state.cursor = Math.min(state.cursor, Math.max(0, state.names.length - 1));
    state.notice = mute(`removed ${state.confirmName}.`);
  }
  state.view = "list";
  return undefined;
}

function onBackKey(state: State, key: Key): LoopSignal {
  if (key.nav === "escape" || key.nav === "enter" || key.text === "q") {
    state.view = "list";
  }
  return undefined;
}

async function loop(state: State, reader: KeyReader, paint: () => void): Promise<string | undefined> {
  paint();
  for (;;) {
    const key = readKey(await reader.next());
    if (key.nav === "interrupt") {
      return undefined;
    }
    try {
      const signal = await VIEWS[state.view].onKey(state, key, paint);
      if (signal === "quit") {
        return undefined;
      }
      if (signal === "launch") {
        const name = selected(state);
        if (name === undefined) {
          continue;
        }
        state.notice = mute(`checking ${name}…`);
        paint();
        const status = await launchStatus(name);
        if (status?.kind === "invalid") {
          state.statuses.set(name, status);
          state.notice = ember(`${cream(name)}'s token is invalid (HTTP ${String(status.status)}) · ${mute("/settings to turn this check off")}`);
        } else {
          return name;
        }
      }
    } catch (error) {
      if (!(error instanceof UserFacingError)) {
        throw error;
      }
      state.view = "list";
      state.notice = ember(error.message);
    }
    paint();
  }
}

export async function interactiveSession(deps: InteractiveDeps): Promise<void> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    await fallbackSession(deps);
    return;
  }
  const names = readIndex();
  const state: State = {
    view: "list",
    names,
    cursor: 0,
    notice: "",
    buffer: "/",
    menuCursor: 0,
    addName: "",
    addToken: "",
    addStage: "name",
    confirmName: "",
    armed: "",
    quitArmed: false,
    detailRows: [],
    closing: false,
    customName: "",
    customStage: "menu",
    customCursor: 0,
    pendingColor: undefined,
    pendingGlyph: undefined,
    editBuffer: "",
    settingsValidate: true,
    pipeline: readSettings().pipeline,
    ioStage: "file",
    ioFile: "",
    statuses: new Map<string, TokenStatus>(Object.entries(readStatusCache()).map(([name, cached]) => [name, cached.status])),
    identities: loadIdentities(names),
    meta: readMeta(),
  };
  output.write(ENTER_ALT + HIDE_CURSOR);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  const reader = new KeyReader();
  const paint = (): void => {
    render(state);
  };
  let target: string | undefined;
  try {
    target = await loop(state, reader, paint);
  } finally {
    state.closing = true;
    reader.close();
    input.setRawMode(false);
    input.pause();
    output.write(SHOW_CURSOR + EXIT_ALT);
  }
  if (target !== undefined) {
    await deps.launch(target, parsePipeline(readSettings().pipeline));
  }
}

async function fallbackSession(deps: InteractiveDeps): Promise<void> {
  const names = readIndex();
  console.log(banner());
  console.log("");
  if (names.length === 0) {
    console.log(mute("no accounts yet. Add one with: ") + cream("cca add <name>"));
    return;
  }
  names.forEach((name, index) => {
    console.log(`  ${cream(String(index + 1))}) ${cream(name)}`);
  });
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question(`\n${mute("number (or q to cancel):")} `)).trim();
  rl.close();
  if (answer === "" || answer.toLowerCase() === "q") {
    console.log(mute("cancelled."));
    return;
  }
  const index = Number(answer) - 1;
  const chosen = names[index];
  if (!Number.isInteger(index) || chosen === undefined) {
    console.log(mute(`invalid selection: ${answer}`));
    return;
  }
  await deps.launch(chosen, parsePipeline(readSettings().pipeline));
}
