import OAuthProvider, { AuthorizationError, CimdFetchError, getOAuthApi, type ConsentDescription, type OAuthProviderOptions, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { handleMcp } from './mcp.ts';
import type { Env } from './types.ts';

const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const SCOPE = 'skills:read';
const safeHeaders = {
  'cache-control': 'no-store, private',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function validConfiguration(env: Env): boolean {
  return !!env.OAUTH_KV && !!env.ASSETS && typeof env.OWNER_PASSPHRASE === 'string' && env.OWNER_PASSPHRASE.length >= 32;
}

async function clientBucket(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.OWNER_PASSPHRASE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`skill2plugin:login:${ip}`));
  return `login:${Array.from(new Uint8Array(digest).slice(0, 16), x => x.toString(16).padStart(2, '0')).join('')}`;
}

async function rateLimit(request: Request, env: Env, failed: boolean): Promise<boolean> {
  const bucket = await clientBucket(request, env);
  const count = Number(await env.OAUTH_KV.get(bucket) ?? '0');
  if (count >= 8) return false;
  if (failed) await env.OAUTH_KV.put(bucket, String(count + 1), { expirationTtl: 600 });
  return true;
}

function passwordMatches(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function consentHtml(info: ConsentDescription, handle: string, error?: string): string {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 Skill2Plugin</title><style>body{font:16px system-ui;max-width:38rem;margin:3rem auto;padding:0 1rem;line-height:1.6}input{width:100%;padding:.6rem}button{padding:.6rem 1rem;margin:.7rem .7rem 0 0}</style><h1>授权 Skill2Plugin</h1><p><strong>${escape(info.clientName)}</strong>（${escape(info.clientDomain ?? '未知来源')}）请求读取你的 Skill，授权结果发送至 <strong>${escape(info.redirectHost)}</strong>。</p><p>权限：${info.scope.map(escape).join(', ')}</p>${error ? `<p role="alert">${escape(error)}</p>` : ''}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}"><label>私有访问口令<input type="password" name="passphrase" required autocomplete="current-password"></label><p><button name="decision" value="approve">同意</button><button name="decision" value="deny">拒绝</button></p></form></html>`;
}

function html(body: string, headers?: Headers): Response {
  const result = new Headers(headers);
  for (const [key, value] of Object.entries(safeHeaders)) result.set(key, value);
  result.set('content-type', 'text/html; charset=utf-8');
  return new Response(body, { headers: result });
}

function providerOptions(env: Env, origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: '/mcp',
    apiHandler: { async fetch(request, workerEnv, context) {
      const auth = (context as typeof context & { auth?: { audience?: string; scope?: string[]; clientId?: string; expiresAt?: number } }).auth;
      if (!auth) return new Response('Unauthorized', { status: 401 });
      if (auth.audience !== `${origin}/mcp` || auth.clientId !== CLIENT_ID || !auth.scope?.includes(SCOPE) || (auth.expiresAt !== undefined && auth.expiresAt <= Date.now() / 1000)) return insufficientScope(auth as never, [SCOPE]);
      return handleMcp(request, workerEnv);
    } },
    defaultHandler: { async fetch(request, workerEnv) { return publicRoute(request, workerEnv, origin); } },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86400,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      resource_name: 'Skill2Plugin private Skills',
    },
    clientIdMetadataDocumentEnabled: true,
  };
}

async function publicRoute(request: Request, env: Env, origin: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/authorize') return authorizationPage(request, env, origin);
  if (url.pathname === '/health' && request.method === 'GET') return new Response(JSON.stringify({ status: 'ok' }), { headers: { ...safeHeaders, 'content-type': 'application/json' } });
  if (url.pathname === '/' && request.method === 'GET') return html(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill2Plugin</title><h1>Skill2Plugin</h1><p>在 ChatGPT 插件设置中添加 MCP 地址：</p><p><code>${escape(origin)}/mcp</code></p><p>然后完成 OAuth 授权。此实例不提供任何 MCP Tools。</p></html>`);
  return new Response('Not found', { status: 404, headers: safeHeaders });
}

async function authorizationPage(request: Request, env: Env, origin: string): Promise<Response> {
  const oauth = getOAuthApi(providerOptions(env, origin), env);
  try {
    if (request.method === 'GET') {
      if (new URL(request.url).searchParams.get('client_id') !== CLIENT_ID) return new Response('Unsupported client', { status: 400, headers: safeHeaders });
      const parsed = await oauth.parseAuthRequest(request);
      if (parsed.clientId !== CLIENT_ID || parsed.redirectUri !== REDIRECT_URI || parsed.scope.length !== 1 || parsed.scope[0] !== SCOPE) return new Response('Unsupported OAuth request', { status: 400, headers: safeHeaders });
      const info = await oauth.describeConsent(parsed);
      const consent = await oauth.beginConsent(parsed);
      return html(consentHtml(info, consent.handle), consent.headers);
    }
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return new Response('Invalid form', { status: 415, headers: safeHeaders });
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') === 'deny') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (form.get('decision') !== 'approve') return new Response('Invalid decision', { status: 400, headers: safeHeaders });
      if (!await rateLimit(request, env, false)) return new Response('Too many attempts', { status: 429, headers: safeHeaders });
      const passphrase = String(form.get('passphrase') ?? '');
      if (!passwordMatches(passphrase, env.OWNER_PASSPHRASE)) {
        await rateLimit(request, env, true);
        return new Response('Invalid passphrase. Restart authorization.', { status: 401, headers: safeHeaders });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      if (approved.request.clientId !== CLIENT_ID || approved.request.redirectUri !== REDIRECT_URI) return new Response('Unsupported OAuth request', { status: 400, headers: safeHeaders });
      const complete = await oauth.completeAuthorization({ request: approved.request, userId: 'owner', metadata: {}, scope: [SCOPE], props: { owner: true } });
      approved.headers.set('Location', complete.redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response('Method not allowed', { status: 405, headers: { ...safeHeaders, allow: 'GET, POST' } });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) return new Response('Invalid or expired authorization request', { status: 400, headers: safeHeaders });
    return new Response('Authorization unavailable', { status: 503, headers: safeHeaders });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!validConfiguration(env)) return new Response('Configuration incomplete', { status: 503, headers: safeHeaders });
    const origin = new URL(request.url).origin;
    try {
      const response = await new OAuthProvider<Env>(providerOptions(env, origin)).fetch(request, env, ctx);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(safeHeaders)) if (!headers.has(key)) headers.set(key, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      return new Response('Service unavailable', { status: 503, headers: safeHeaders });
    }
  },
};
