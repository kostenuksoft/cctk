import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import { join } from "node:path";
import { IS_WINDOWS, configDir, configDirFor, die, isAccountName, prepareConfigDir, readIndex, readMeta, readSettings, readVersion, scrubCredentials, setMeta, writeCachedStatus, writeSettings } from "./core.ts";
import { formatPipeline, parsePipeline } from "./pipeline.ts";
import { accent, banner, bold, clay, cream, mute, swatch, GLYPHS, SPARKLE } from "./theme.ts";
import { seal, unseal, parseSealed } from "./crypt.ts";
import { promptHidden } from "./prompt.ts";
import { validateToken } from "./validate.ts";
import { readIdentity } from "./identity.ts";
import { accountRows, addAccount, applyImport, buildExport, launchStatus, parseBundle, removeAccount, statusLabel, verifyAccount } from "./accounts.ts";
import { detectStore } from "./secrets/store.ts";
import { interactiveSession } from "./interactive.ts";

const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

interface Command {
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly summary: string;
  readonly run: (args: string[]) => void | Promise<void>;
}

function validName(name: string): boolean {
  return isAccountName(name) && !RESERVED.has(name);
}

function requireName(name: string): string {
  if (!validName(name)) {
    die(`invalid account name: ${name}`);
  }
  return name;
}

async function addCommand(args: string[]): Promise<void> {
  const name = requireName(args[0] ?? die("usage: cca add | -a <name>"));
  console.log(mute(`run '${cream("claude setup-token")}' first, then paste the token below (hidden).`));
  const token = await promptHidden(`${clay(name)} token: `);
  if (token === "") {
    die("no token entered");
  }
  const { status, existed, backend } = await addAccount(name, token);
  if (status.kind === "invalid") {
    die(`token rejected by the API (HTTP ${status.status}) — not stored. Generate a fresh one with 'claude setup-token'.`);
  }
  console.log(`${clay(SPARKLE)} ${existed ? "updated" : "added"} ${cream(name)} ${mute(`(${backend ?? "keyring"}, encrypted)`)}`);
  if (status.kind === "unknown") {
    console.log(mute(`  could not verify the token (${status.reason}) — stored without a validity check.`));
  }
}

function listCommand(): void {
  const names = readIndex();
  console.log(banner());
  console.log("");
  if (names.length === 0) {
    console.log(mute("no accounts yet. Add one with: ") + cream("cca add <name>"));
    return;
  }
  const width = Math.max(...names.map((name) => name.length));
  const meta = readMeta();
  for (const name of names) {
    const identity = readIdentity(name);
    const detail = identity === undefined ? "" : `  ${mute(identity.email || identity.displayName)}`;
    console.log(`  ${swatch(name, meta[name]?.color, meta[name]?.glyph)} ${accent(name, meta[name]?.color, name.padEnd(width))}${detail}`);
  }
  console.log(`\n${mute("launch with:")} ${cream("cca <name> [claude args]")}  ${mute("· details:")} ${cream("cca info <name>")}`);
}

async function infoCommand(args: string[]): Promise<void> {
  const name = requireName(args[0] ?? die("usage: cca info | -i <name>"));
  if (!readIndex().includes(name)) {
    die(`no such account: ${name}`);
  }
  const token = detectStore().read(name);
  const status = await validateToken(token);
  if (status.kind !== "unknown") {
    writeCachedStatus(name, status);
  }
  const identity = readIdentity(name);
  const entry = readMeta()[name];
  const rows = accountRows(name, statusLabel(status), identity, token);
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(banner());
  console.log("");
  console.log(`  ${swatch(name, entry?.color, entry?.glyph)} ${bold(accent(name, entry?.color, name))}`);
  console.log("");
  for (const [label, value] of rows) {
    console.log(`  ${mute(label.padEnd(width))}  ${value}`);
  }
}

async function checkCommand(args: string[]): Promise<void> {
  const names = args[0] === undefined ? readIndex() : [requireName(args[0])];
  console.log(banner());
  console.log("");
  if (names.length === 0) {
    console.log(mute("no accounts to check."));
    return;
  }
  const width = Math.max(...names.map((account) => account.length));
  for (const account of names) {
    const status = await verifyAccount(account);
    console.log(`  ${cream(account.padEnd(width))}  ${statusLabel(status)}`);
  }
}

function removeCommand(args: string[]): void {
  const name = requireName(args[0] ?? die("usage: cca remove | rm | -r <name>"));
  if (!readIndex().includes(name)) {
    die(`no such account: ${name}`);
  }
  removeAccount(name);
  console.log(`${clay(SPARKLE)} removed ${cream(name)}`);
}

function colorCommand(args: string[]): void {
  const name = requireName(args[0] ?? die("usage: cca color <name> [r g b]"));
  if (!readIndex().includes(name)) {
    die(`no such account: ${name}`);
  }
  const parts = args.slice(1).join(" ").split(/[^0-9]+/).filter((part) => part !== "");
  if (parts.length === 0) {
    setMeta(name, { color: undefined });
    console.log(`${clay(SPARKLE)} reset ${cream(name)} to its default color`);
    return;
  }
  if (parts.length !== 3) {
    die("give three values 0–255: cca color <name> <r> <g> <b>");
  }
  const rgb = parts.map(Number) as [number, number, number];
  if (rgb.some((value) => value > 255)) {
    die("rgb values must be 0–255");
  }
  setMeta(name, { color: rgb });
  console.log(`${clay(SPARKLE)} ${swatch(name, rgb, readMeta()[name]?.glyph)} ${cream(name)} set to ${mute(rgb.join(", "))}`);
}

function projectDir(root: string): string {
  return join(root, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
}

function latestSession(dir: string): string | undefined {
  if (!fs.existsSync(dir)) {
    return undefined;
  }
  const sessions = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => ({ id: file.slice(0, -6), at: fs.statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return sessions[0]?.id;
}

function sessionIsLive(root: string, sessionId: string): boolean {
  const dir = join(root, "sessions");
  if (!fs.existsSync(dir)) {
    return false;
  }
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const record: unknown = JSON.parse(fs.readFileSync(join(dir, file), "utf8"));
      if (typeof record === "object" && record !== null) {
        const entry = record as Record<string, unknown>;
        if (entry.status === "busy" && entry.sessionId === sessionId) {
          return true;
        }
      }
    } catch {
      continue;
    }
  }
  return false;
}

function carryConversation(name: string, args: string[]): string[] {
  const continueIndex = args.findIndex((arg) => arg === "--continue" || arg === "-c");
  const resumeIndex = args.findIndex((arg) => arg === "--resume" || arg === "-r");
  if (continueIndex === -1 && resumeIndex === -1) {
    return args;
  }
  if (!readIndex().includes(name)) {
    die(`no such account: ${name}`);
  }
  const source = configDir();
  const sourceProject = projectDir(source);
  let sessionId: string;
  let passthrough: string[];
  if (resumeIndex !== -1) {
    sessionId = args[resumeIndex + 1] ?? die("usage: cca <name> --resume <session-id>");
    passthrough = [...args.slice(0, resumeIndex), ...args.slice(resumeIndex + 2)];
  } else {
    sessionId = latestSession(sourceProject) ?? die("no conversation in this directory to continue");
    passthrough = [...args.slice(0, continueIndex), ...args.slice(continueIndex + 1)];
  }
  const sourceFile = join(sourceProject, `${sessionId}.jsonl`);
  if (!fs.existsSync(sourceFile)) {
    die(`no conversation ${sessionId} found in this directory`);
  }
  if (sessionIsLive(source, sessionId)) {
    console.error(mute("note: that conversation looks like it's still open — if the resumed copy is truncated, exit that session and try again."));
  }
  const targetProject = projectDir(configDirFor(name));
  fs.mkdirSync(targetProject, { recursive: true });
  fs.copyFileSync(sourceFile, join(targetProject, `${sessionId}.jsonl`));
  console.log(`${clay(SPARKLE)} continuing ${cream(sessionId.slice(0, 8))} as ${cream(name)}`);
  return ["--resume", sessionId, ...passthrough];
}

async function launch(name: string, args: string[]): Promise<never> {
  const claudeArgs = carryConversation(name, args);
  const token = detectStore().read(name);
  const configDir = prepareConfigDir(name);
  const result = spawnSync("claude", claudeArgs, {
    stdio: "inherit",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, [TOKEN_ENV]: token },
    shell: IS_WINDOWS,
  });
  scrubCredentials(configDir);
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    die(err.code === "ENOENT" ? "'claude' not found on PATH" : err.message);
  }
  process.exit(result.status ?? 0);
}

function glyphCommand(args: string[]): void {
  const name = requireName(args[0] ?? die("usage: cca glyph <name> [glyph]"));
  if (!readIndex().includes(name)) {
    die(`no such account: ${name}`);
  }
  const glyph = args[1];
  if (glyph === undefined) {
    setMeta(name, { glyph: undefined });
    console.log(`${clay(SPARKLE)} reset ${cream(name)} to the default block`);
    return;
  }
  if (!GLYPHS.includes(glyph)) {
    die(`glyph must be one of: ${GLYPHS.join(" ")}`);
  }
  setMeta(name, { glyph });
  console.log(`${clay(SPARKLE)} ${swatch(name, readMeta()[name]?.color, glyph)} ${cream(name)} glyph set`);
}

function settingsCommand(args: string[]): void {
  const settings = readSettings();
  if (args[0] === undefined) {
    console.log(banner());
    console.log("");
    console.log(`  ${clay("validate-on-launch".padEnd(18))}  ${cream(settings.validateOnLaunch ? "on" : "off")}`);
    console.log(`\n${mute("check the account's token once, right before launching it.")}`);
    console.log(`${mute("change with:")} ${cream("cca settings validate-on-launch on|off")}`);
    return;
  }
  if (args[0] !== "validate-on-launch") {
    die(`unknown setting: ${args[0]}`);
  }
  const value = args[1];
  if (value !== "on" && value !== "off") {
    die("usage: cca settings validate-on-launch on|off");
  }
  writeSettings({ validateOnLaunch: value === "on" });
  console.log(`${clay(SPARKLE)} validate-on-launch ${cream(value)}`);
}

function reportPipeline(flags: string[]): void {
  if (flags.length === 0) {
    console.log(`${clay(SPARKLE)} pipeline cleared — picker launches start a fresh session`);
    return;
  }
  console.log(`${clay(SPARKLE)} pipeline saved: ${cream(formatPipeline(flags))}`);
}

function savePipeline(raw: string): void {
  writeSettings({ pipeline: raw });
  reportPipeline(parsePipeline(raw));
}

async function pipelineCommand(args: string[]): Promise<void> {
  if (args.length > 0) {
    savePipeline(args.join("\n"));
    return;
  }
  const current = formatPipeline(parsePipeline(readSettings().pipeline));
  if (!process.stdin.isTTY) {
    console.log(current === "" ? mute("pipeline: (empty)") : `${mute("pipeline:")} ${cream(current)}`);
    console.log(mute("set it with: ") + cream("cca pipeline <flags…>"));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pending = rl.question(`${clay("pipeline")} ${mute("flags:")} `);
  rl.write(current);
  const answer = await pending;
  rl.close();
  savePipeline(answer.trim());
}

async function exportCommand(args: string[]): Promise<void> {
  const file = args[0] ?? die("usage: cca export <file>");
  const bundle = buildExport();
  if (bundle.accounts.length === 0) {
    die("no accounts to export");
  }
  const passphrase = await promptHidden("passphrase to encrypt the export: ");
  if (passphrase === "") {
    die("no passphrase entered");
  }
  if ((await promptHidden("confirm passphrase: ")) !== passphrase) {
    die("passphrases don't match");
  }
  fs.writeFileSync(file, `${JSON.stringify(seal(JSON.stringify(bundle), passphrase), null, 2)}\n`, { mode: 0o600 });
  const count = `${cream(String(bundle.accounts.length))} account${bundle.accounts.length === 1 ? "" : "s"}`;
  console.log(`${clay(SPARKLE)} exported ${count} to ${cream(file)} ${mute("(encrypted — you'll need the passphrase to import)")}`);
}

async function importCommand(args: string[]): Promise<void> {
  const file = args[0] ?? die("usage: cca import <file>");
  if (!fs.existsSync(file)) {
    die(`no such file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    die(`${file} is not a cca export file`);
  }
  const sealed = parseSealed(parsed) ?? die(`${file} is not a cca export file`);
  const passphrase = await promptHidden("passphrase: ");
  let json: string;
  try {
    json = unseal(sealed, passphrase);
  } catch {
    die("wrong passphrase, or the file was tampered with");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    die("the export file is corrupt");
  }
  const bundle = parseBundle(decoded);
  if (bundle.accounts.length === 0) {
    die("no importable accounts in that file");
  }
  const added = applyImport(bundle);
  console.log(`${clay(SPARKLE)} imported ${cream(String(added.length))} account${added.length === 1 ? "" : "s"}: ${added.map((name) => cream(name)).join(", ")}`);
}

function versionCommand(): void {
  console.log(`${clay("cca")} ${cream(readVersion())}`);
}

function help(): void {
  const rows: Array<readonly [string, string]> = [
    ["cca", "pick an account, then launch"],
    ["cca <name> [args]", "launch 'claude' as <name>, passing args through"],
    ["cca <name> --continue", "carry your current conversation over to <name>"],
    ["cca <name> --resume <id>", "same, for a specific session id"],
    ...COMMANDS.map((command) => [command.usage, command.summary] as const),
  ];
  const width = Math.max(...rows.map(([usage]) => usage.length));
  console.log(banner());
  console.log("");
  for (const [usage, summary] of rows) {
    console.log(`  ${clay(usage.padEnd(width))}  ${mute(summary)}`);
  }
  console.log(
    `\n${mute(`tokens are encrypted per-user (libsecret / DPAPI / Keychain), validated against the API, and injected as ${TOKEN_ENV} into an isolated per-account CLAUDE_CONFIG_DIR so 'claude' authenticates as that account.`)}`,
  );
  console.log(`\n${mute("questions or issues:")} ${cream("github.com/kostenuksoft/cctk")}`);
}

const COMMANDS: readonly Command[] = [
  { aliases: ["add", "-a"], usage: "add | -a <name>", summary: "store a token (hidden input, encrypted, validated)", run: addCommand },
  { aliases: ["list", "ls", "-l"], usage: "list | ls | -l", summary: "list saved accounts", run: listCommand },
  { aliases: ["check", "-c"], usage: "check | -c [name]", summary: "verify stored token(s) against the API", run: checkCommand },
  { aliases: ["info", "-i"], usage: "info | -i <name>", summary: "show account identity, plan, and validity", run: infoCommand },
  { aliases: ["remove", "rm", "-r"], usage: "remove | rm | -r <name>", summary: "forget an account", run: removeCommand },
  { aliases: ["color"], usage: "color <name> [r g b]", summary: "set an account's color (omit rgb to reset)", run: colorCommand },
  { aliases: ["glyph"], usage: "glyph <name> [glyph]", summary: "set an account's glyph (omit to reset)", run: glyphCommand },
  { aliases: ["settings"], usage: "settings [validate-on-launch on|off]", summary: "view or change settings", run: settingsCommand },
  { aliases: ["pipeline"], usage: "pipeline [flags…]", summary: "edit the launch flags the picker applies", run: pipelineCommand },
  { aliases: ["export"], usage: "export <file>", summary: "export accounts to an encrypted file (passphrase)", run: exportCommand },
  { aliases: ["import"], usage: "import <file>", summary: "import accounts from an encrypted export", run: importCommand },
  { aliases: ["version", "-v", "--version"], usage: "version | -v", summary: "print the cca version", run: versionCommand },
  { aliases: ["help", "-h", "--help"], usage: "help | -h", summary: "show this help", run: help },
];

const RESERVED = new Set(COMMANDS.flatMap((command) => command.aliases));

export async function run(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === undefined) {
    await interactiveSession({ launch });
    return;
  }
  const command = COMMANDS.find((candidate) => candidate.aliases.includes(first));
  if (command === undefined) {
    const status = await launchStatus(first);
    if (status?.kind === "invalid") {
      die(`${cream(first)}'s token is invalid (HTTP ${status.status}). Refresh it: run '${cream("claude setup-token")}' then '${cream(`cca add ${first}`)}'.  ${mute("(turn this off: cca settings validate-on-launch off)")}`);
    }
    await launch(first, rest);
    return;
  }
  await command.run(rest);
}
