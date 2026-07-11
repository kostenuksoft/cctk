import * as fs from "node:fs";
import { clearCachedStatus, clearMeta, configDirFor, die, forgetName, isAccountName, isRgb, readIndex, readMeta, readSettings, readStatusCache, rememberName, removeConfigDir, setMeta, writeCachedStatus } from "./core.ts";
import { ember, mute, sage, type Rgb } from "./theme.ts";
import { validateToken, type TokenStatus } from "./validate.ts";
import { planLabel, type AccountIdentity } from "./identity.ts";
import { detectStore } from "./secrets/store.ts";
import type { BackendName } from "./secrets/types.ts";

export function statusLabel(status: TokenStatus | undefined): string {
  if (status === undefined) {
    return "";
  }
  if (status.kind === "valid") {
    return sage("● valid");
  }
  if (status.kind === "invalid") {
    return ember(`● invalid (HTTP ${String(status.status)})`);
  }
  return mute(`● unverified (${status.reason})`);
}

export function fingerprint(token: string): string {
  return token.length <= 16 ? token : `${token.slice(0, 12)}…${token.slice(-4)}`;
}

export function accountRows(
  name: string,
  statusText: string,
  identity: AccountIdentity | undefined,
  token: string,
): Array<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [["status", statusText]];
  if (identity === undefined) {
    rows.push(["account", mute("unknown — launch once to populate")]);
  } else {
    if (identity.email !== "") {
      rows.push(["account", identity.email]);
    }
    if (identity.displayName !== "") {
      rows.push(["name", identity.displayName]);
    }
    if (identity.organizationName !== "") {
      rows.push(["org", identity.organizationName]);
    }
    if (identity.plan !== "") {
      rows.push(["plan", planLabel(identity.plan)]);
    }
  }
  rows.push(["config", configDirFor(name)]);
  rows.push(["token", mute(fingerprint(token))]);
  return rows;
}

export interface AddOutcome {
  readonly status: TokenStatus;
  readonly existed: boolean;
  readonly backend: BackendName | undefined;
}

export async function addAccount(name: string, token: string): Promise<AddOutcome> {
  const status = await validateToken(token);
  const existed = readIndex().includes(name);
  if (status.kind === "invalid") {
    return { status, existed, backend: undefined };
  }
  const store = detectStore();
  store.store(name, token);
  rememberName(name);
  return { status, existed, backend: store.name };
}

export function removeAccount(name: string): void {
  detectStore().remove(name);
  forgetName(name);
  removeConfigDir(name);
  clearMeta(name);
  clearCachedStatus(name);
}

export function renameAccount(oldName: string, newName: string): void {
  const store = detectStore();
  const token = store.read(oldName);
  store.store(newName, token);
  store.remove(oldName);
  const oldDir = configDirFor(oldName);
  if (fs.existsSync(oldDir)) {
    fs.renameSync(oldDir, configDirFor(newName));
  }
  const meta = readMeta()[oldName];
  if (meta !== undefined) {
    setMeta(newName, meta);
    clearMeta(oldName);
  }
  const cached = readStatusCache()[oldName];
  if (cached !== undefined) {
    writeCachedStatus(newName, cached.status);
    clearCachedStatus(oldName);
  }
  forgetName(oldName);
  rememberName(newName);
}

export async function verifyAccount(name: string): Promise<TokenStatus> {
  const status = await validateToken(detectStore().read(name));
  if (status.kind !== "unknown") {
    writeCachedStatus(name, status);
  }
  return status;
}

export async function launchStatus(name: string): Promise<TokenStatus | undefined> {
  if (!readSettings().validateOnLaunch) {
    return undefined;
  }
  return verifyAccount(name);
}

export interface ExportAccount {
  readonly name: string;
  readonly token: string;
  readonly color?: Rgb;
  readonly glyph?: string;
}

export interface ExportBundle {
  readonly version: number;
  readonly exportedAt: string;
  readonly accounts: readonly ExportAccount[];
}

export function buildExport(): ExportBundle {
  const store = detectStore();
  const meta = readMeta();
  const accounts = readIndex().map((name): ExportAccount => {
    const entry = meta[name];
    return { name, token: store.read(name), color: entry?.color, glyph: entry?.glyph };
  });
  return { version: 1, exportedAt: new Date().toISOString(), accounts };
}

export function parseBundle(value: unknown): ExportBundle {
  if (typeof value !== "object" || value === null || !Array.isArray((value as Record<string, unknown>).accounts)) {
    die("not a valid cca export file");
  }
  const accounts: ExportAccount[] = [];
  for (const item of (value as { accounts: unknown[] }).accounts) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string" || !isAccountName(entry.name) || typeof entry.token !== "string") {
      continue;
    }
    accounts.push({
      name: entry.name,
      token: entry.token,
      color: isRgb(entry.color) ? entry.color : undefined,
      glyph: typeof entry.glyph === "string" && entry.glyph !== "" ? entry.glyph : undefined,
    });
  }
  return { version: 1, exportedAt: new Date().toISOString(), accounts };
}

export function applyImport(bundle: ExportBundle): string[] {
  const store = detectStore();
  const added: string[] = [];
  for (const account of bundle.accounts) {
    store.store(account.name, account.token);
    rememberName(account.name);
    setMeta(account.name, { color: account.color, glyph: account.glyph });
    added.push(account.name);
  }
  return added;
}
