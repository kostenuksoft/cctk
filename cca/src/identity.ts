import { join } from "node:path";
import * as fs from "node:fs";
import { configDirFor } from "./core.ts";

export interface AccountIdentity {
  readonly email: string;
  readonly displayName: string;
  readonly organizationName: string;
  readonly plan: string;
}

function field(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

export function readIdentity(name: string): AccountIdentity | undefined {
  const file = join(configDirFor(name), ".claude.json");
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const account: unknown = (parsed as Record<string, unknown>).oauthAccount;
  if (typeof account !== "object" || account === null) {
    return undefined;
  }
  const source = account as Record<string, unknown>;
  const identity: AccountIdentity = {
    email: field(source, "emailAddress"),
    displayName: field(source, "displayName"),
    organizationName: field(source, "organizationName"),
    plan: field(source, "organizationType"),
  };
  if (identity.email === "" && identity.displayName === "") {
    return undefined;
  }
  return identity;
}

const PLAN_LABELS: Record<string, string> = {
  claude_pro: "Claude Pro",
  claude_max: "Claude Max",
  claude_team: "Claude Team",
  claude_enterprise: "Claude Enterprise",
  claude_free: "Claude Free",
};

export function planLabel(plan: string): string {
  return PLAN_LABELS[plan] ?? plan;
}
