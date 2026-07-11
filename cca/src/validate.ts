const DEFAULT_API_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
const VALIDATE_TIMEOUT_MS = 6_000;

export type TokenStatus =
  | { readonly kind: "valid" }
  | { readonly kind: "invalid"; readonly status: number }
  | { readonly kind: "unknown"; readonly reason: string };

export async function validateToken(token: string): Promise<TokenStatus> {
  const base = (process.env.ANTHROPIC_BASE_URL ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, VALIDATE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/v1/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": OAUTH_BETA,
      },
      signal: controller.signal,
    });
    if (response.status === 200) {
      return { kind: "valid" };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: "invalid", status: response.status };
    }
    return { kind: "unknown", reason: `HTTP ${response.status}` };
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
