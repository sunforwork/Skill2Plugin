export interface Env {
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  OWNER_PASSPHRASE: string;
  COOKIE_SECRET: string;
  PUBLIC_ORIGIN: string;
}
