import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";
import { clay, SPARKLE, type Rgb } from "./theme.ts";
import type { TokenStatus } from "./validate.ts";

export const IS_WINDOWS = process.platform === "win32";
const INDEX_FILE = "accounts.json";
const ACCOUNT_NAME = /^[A-Za-z0-9._-]+$/;

export function isAccountName(name: string): boolean {
  return ACCOUNT_NAME.test(name);
}

export class UserFacingError extends Error {}

export function die(message: string): never {
  throw new UserFacingError(message);
}

export function reportError(error: unknown): void {
  if (error instanceof UserFacingError) {
    console.error(`${clay(SPARKLE)} ${error.message}`);
    return;
  }
  console.error(`${clay(SPARKLE)} unexpected error — this is a bug:`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

export function assertOk(result: SpawnSyncReturns<string>, label: string): void {
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    die(err.code === "ENOENT" ? `${label}: command not found` : `${label}: ${err.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    die(`${label} failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
  }
}

export function configDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.length > 0 ? override : join(homedir(), ".claude");
}

export function tokenDir(): string {
  return join(configDir(), "account-tokens");
}

export function readVersion(): string {
  const file = fileURLToPath(new URL("../package.json", import.meta.url));
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed === "object" && parsed !== null) {
    const version = (parsed as Record<string, unknown>).version;
    if (typeof version === "string") {
      return version;
    }
  }
  return "unknown";
}

export function configDirFor(name: string): string {
  return join(tokenDir(), "configs", name);
}

export function prepareConfigDir(name: string): string {
  const dir = configDirFor(name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function scrubCredentials(dir: string): void {
  const file = join(dir, ".credentials.json");
  if (fs.existsSync(file)) {
    fs.rmSync(file);
  }
}

export function removeConfigDir(name: string): void {
  const dir = configDirFor(name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

function indexPath(): string {
  return join(tokenDir(), INDEX_FILE);
}

export function readIndex(): string[] {
  const path = indexPath();
  if (!fs.existsSync(path)) {
    return [];
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function writeIndex(names: string[]): void {
  fs.mkdirSync(tokenDir(), { recursive: true });
  fs.writeFileSync(indexPath(), JSON.stringify([...new Set(names)].sort(), null, 2));
}

export function rememberName(name: string): void {
  writeIndex([...readIndex(), name]);
}

export function forgetName(name: string): void {
  writeIndex(readIndex().filter((entry) => entry !== name));
}

export interface AccountMeta {
  readonly color?: Rgb;
  readonly glyph?: string;
}

function metaPath(): string {
  return join(tokenDir(), "meta.json");
}

export function isRgb(value: unknown): value is Rgb {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255);
}

function parseMeta(value: unknown): AccountMeta | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const meta: { color?: Rgb; glyph?: string } = {};
  if (isRgb(entry.color)) {
    meta.color = entry.color;
  }
  if (typeof entry.glyph === "string" && entry.glyph !== "") {
    meta.glyph = entry.glyph;
  }
  return meta.color === undefined && meta.glyph === undefined ? undefined : meta;
}

export function readMeta(): Record<string, AccountMeta> {
  const path = metaPath();
  if (!fs.existsSync(path)) {
    return {};
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const meta: Record<string, AccountMeta> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = parseMeta(value);
    if (entry !== undefined) {
      meta[name] = entry;
    }
  }
  return meta;
}

function writeMeta(meta: Record<string, AccountMeta>): void {
  fs.mkdirSync(tokenDir(), { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

export function setMeta(name: string, patch: Partial<AccountMeta>): void {
  const meta = readMeta();
  const merged = { ...meta[name], ...patch };
  const clean: { color?: Rgb; glyph?: string } = {};
  if (merged.color !== undefined) {
    clean.color = merged.color;
  }
  if (typeof merged.glyph === "string" && merged.glyph !== "") {
    clean.glyph = merged.glyph;
  }
  if (clean.color === undefined && clean.glyph === undefined) {
    delete meta[name];
  } else {
    meta[name] = clean;
  }
  writeMeta(meta);
}

export function clearMeta(name: string): void {
  const meta = readMeta();
  if (name in meta) {
    delete meta[name];
    writeMeta(meta);
  }
}

export interface Settings {
  readonly validateOnLaunch: boolean;
  readonly pipeline: string;
}

const DEFAULT_SETTINGS: Settings = { validateOnLaunch: true, pipeline: "" };

function settingsPath(): string {
  return join(tokenDir(), "settings.json");
}

export function readSettings(): Settings {
  const path = settingsPath();
  if (!fs.existsSync(path)) {
    return DEFAULT_SETTINGS;
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_SETTINGS;
  }
  const entry = parsed as Record<string, unknown>;
  return {
    validateOnLaunch: typeof entry.validateOnLaunch === "boolean" ? entry.validateOnLaunch : DEFAULT_SETTINGS.validateOnLaunch,
    pipeline: typeof entry.pipeline === "string" ? entry.pipeline : DEFAULT_SETTINGS.pipeline,
  };
}

export function writeSettings(patch: Partial<Settings>): void {
  const merged: Settings = { ...readSettings(), ...patch };
  fs.mkdirSync(tokenDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
}

export interface CachedStatus {
  readonly status: TokenStatus;
  readonly at: number;
}

function statusCachePath(): string {
  return join(tokenDir(), "statuses.json");
}

function parseCached(value: unknown): CachedStatus | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.at !== "number") {
    return undefined;
  }
  if (entry.kind === "valid") {
    return { status: { kind: "valid" }, at: entry.at };
  }
  if (entry.kind === "invalid" && typeof entry.status === "number") {
    return { status: { kind: "invalid", status: entry.status }, at: entry.at };
  }
  if (entry.kind === "unknown" && typeof entry.reason === "string") {
    return { status: { kind: "unknown", reason: entry.reason }, at: entry.at };
  }
  return undefined;
}

export function readStatusCache(): Record<string, CachedStatus> {
  const path = statusCachePath();
  if (!fs.existsSync(path)) {
    return {};
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const cache: Record<string, CachedStatus> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const cached = parseCached(value);
    if (cached !== undefined) {
      cache[name] = cached;
    }
  }
  return cache;
}

function writeStatusCache(cache: Record<string, CachedStatus>): void {
  const serialised: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(cache)) {
    serialised[name] = { ...entry.status, at: entry.at };
  }
  fs.mkdirSync(tokenDir(), { recursive: true });
  fs.writeFileSync(statusCachePath(), JSON.stringify(serialised, null, 2));
}

export function writeCachedStatus(name: string, status: TokenStatus): void {
  const cache = readStatusCache();
  cache[name] = { status, at: Date.now() };
  writeStatusCache(cache);
}

export function clearCachedStatus(name: string): void {
  const cache = readStatusCache();
  if (name in cache) {
    delete cache[name];
    writeStatusCache(cache);
  }
}
