import { spawnSync } from "node:child_process";
import { assertOk, die } from "../core.ts";
import { SERVICE, type SecretStore } from "./types.ts";

export const libsecretStore: SecretStore = {
  name: "libsecret",
  store(account, token) {
    assertOk(
      spawnSync(
        "secret-tool",
        ["store", "--label", `${SERVICE}:${account}`, "service", SERVICE, "account", account],
        { input: token, encoding: "utf8" },
      ),
      "secret-tool store",
    );
  },
  read(account) {
    const result = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], {
      encoding: "utf8",
    });
    if (result.error) {
      assertOk(result, "secret-tool lookup");
    }
    if (result.status !== 0) {
      die(`no token stored for ${account}`);
    }
    return result.stdout.replace(/\n$/, "");
  },
  remove(account) {
    const result = spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { encoding: "utf8" });
    if (result.error) {
      assertOk(result, "secret-tool clear");
    } else if (result.status !== 0 && result.stderr.trim() !== "") {
      die(`secret-tool clear failed: ${result.stderr.trim()}`);
    }
  },
};
