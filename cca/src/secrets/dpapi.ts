import { join } from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { assertOk, die, tokenDir } from "../core.ts";
import { type SecretStore } from "./types.ts";

const SUFFIX = ".dpapi";
const ENCRYPT =
  "$t = [Console]::In.ReadToEnd(); ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString";
const DECRYPT =
  "$e = [Console]::In.ReadToEnd().Trim(); $s = $e | ConvertTo-SecureString; " +
  "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

function secretFile(account: string): string {
  return join(tokenDir(), `${account}${SUFFIX}`);
}

function powershell(script: string, data: string): string {
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: data,
    encoding: "utf8",
  });
  assertOk(result, "powershell");
  return result.stdout;
}

export const dpapiStore: SecretStore = {
  name: "dpapi",
  store(account, token) {
    fs.mkdirSync(tokenDir(), { recursive: true });
    fs.writeFileSync(secretFile(account), powershell(ENCRYPT, token).trim(), { mode: 0o600 });
  },
  read(account) {
    const path = secretFile(account);
    if (!fs.existsSync(path)) {
      die(`no token stored for ${account}`);
    }
    return powershell(DECRYPT, fs.readFileSync(path, "utf8")).replace(/\r?\n$/, "");
  },
  remove(account) {
    const path = secretFile(account);
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
  },
};
