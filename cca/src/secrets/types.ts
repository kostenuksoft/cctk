export type BackendName = "libsecret" | "dpapi" | "keychain";

export interface SecretStore {
  readonly name: BackendName;
  store(account: string, token: string): void;
  read(account: string): string;
  remove(account: string): void;
}

export const SERVICE = "cca";
