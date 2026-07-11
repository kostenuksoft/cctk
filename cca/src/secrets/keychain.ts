import { spawnSync } from "node:child_process";
import { assertOk, die } from "../core.ts";
import { SERVICE, type SecretStore } from "./types.ts";

export const keychainStore: SecretStore = {
  name: "keychain",
  store(account, token) {
    assertOk(
      spawnSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", token], {
        encoding: "utf8",
      }),
      "security add-generic-password",
    );
  },
  read(account) {
    const result = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
    });
    if (result.error) {
      assertOk(result, "security find-generic-password");
    }
    if (result.status !== 0) {
      die(`no token stored for ${account}`);
    }
    return result.stdout.replace(/\n$/, "");
  },
  remove(account) {
    const result = spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
    if (result.error) {
      assertOk(result, "security delete-generic-password");
    }
  },
};
