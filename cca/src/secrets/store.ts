import { spawnSync } from "node:child_process";
import { IS_WINDOWS, die } from "../core.ts";
import type { SecretStore } from "./types.ts";
import { libsecretStore } from "./libsecret.ts";
import { dpapiStore } from "./dpapi.ts";
import { keychainStore } from "./keychain.ts";

export function detectStore(): SecretStore {
  if (IS_WINDOWS) {
    return dpapiStore;
  }
  if (process.platform === "darwin") {
    return keychainStore;
  }
  const probe = spawnSync("secret-tool", [], { encoding: "utf8" });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
    die("no OS keyring found: install libsecret (provides 'secret-tool') to encrypt tokens at rest");
  }
  return libsecretStore;
}
