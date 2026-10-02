import OAuthProvider, { AuthorizationError, CimdFetchError, getOAuthApi, type ConsentDescription, type OAuthProviderOptions, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { handleMcp } from './mcp.ts';
import type { Env } from './types.ts';

const SCOPE = 'skills:read';
const safeHeaders = {
  'cache-control': 'no-store, private',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function validConfiguration(env: Env): boolean {
  return !!env.OAUTH_KV && !!env.ASSETS;
}

function isChatGptCimd(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && url.pathname.startsWith('/oauth/') && url.pathname.endsWith('/client.json');
  } catch {
    return false;
  }
}

function consentHtml(info: ConsentDescription, handle: string): string {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 Skill2Plugin</title><style>body{font:16px system-ui;max-width:38rem;margin:3rem auto;padding:0 1rem;line-height:1.6}button{padding:.6rem 1rem;margin:.7rem .7rem 0 0}</style><h1>授权 Skill2Plugin</h1><p><strong>OAuth 调试模式：</strong>当前暂时不要求部署者口令。</p><p><strong>${escape(info.clientName)}</strong>（${escape(info.clientDomain ?? '未知来源')}）请求读取你的 Skill，授权结果发送至 <strong>${escape(info.redirectHost)}</strong>。</p><p>权限：${info.scope.map(escape).join(', ')}</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}"><p><button name="decision" value="approve">同意</button><button name="decision" value="deny">拒绝</button></p></form></html>`;
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
      if (auth.audience !== `${origin}/mcp` || !auth.clientId || !isChatGptCimd(auth.clientId) || !auth.scope?.includes(SCOPE) || (auth.expiresAt !== undefined && auth.expiresAt <= Date.now() / 1000)) return insufficientScope(auth as never, [SCOPE]);
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
  if (url.pathname === '/health' && request.method === 'GET') return new Response(JSON.stringify({ status: 'ok', oauthDebugMode: true }), { headers: { ...safeHeaders, 'content-type': 'application/json' } });
  if (url.pathname === '/' && request.method === 'GET') return html(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill2Plugin</title><h1>Skill2Plugin</h1><p>在 ChatGPT 插件设置中添加 MCP 地址：</p><p><code>${escape(origin)}/mcp</code></p><p><strong>OAuth 调试模式：暂时不要求部署者口令。</strong></p><p>然后完成 OAuth 授权。此实例不提供任何 MCP Tools。</p></html>`);
  return new Response('Not found', { status: 404, headers: safeHeaders });
}

function cookieNames(request: Request): string[] {
  const raw = request.headers.get('cookie');
  if (!raw) return [];
  return raw.split(';').map(part => part.trim().split('=')[0]).filter(Boolean);
}

function errorForLog(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  const record = error as Error & Record<string, unknown>;
  return {
    name: error.name,
    message: error.message,
    code: record.code,
    description: record.description,
    reason: record.reason,
    detail: record.detail,
    hasRedirect: typeof record.redirectTo === 'string',
  };
}

async function authorizationPage(request: Request, env: Env, origin: string): Promise<Response> {
  const oauth = getOAuthApi(providerOptions(env, origin), env);
  let stage = 'start';
  try {
    if (request.method === 'GET') {
      stage = 'parseAuthRequest';
      const parsed = await oauth.parseAuthRequest(request);
      if (!isChatGptCimd(parsed.clientId) || parsed.scope.some((scope: string) => scope !== SCOPE)) return new Response('Unsupported OAuth request', { status: 400, headers: safeHeaders });
      stage = 'describeConsent';
      const info = await oauth.describeConsent(parsed);
      stage = 'beginConsent';
      const consent = await oauth.beginConsent(parsed);
      console.log('OAuth consent started', {
        clientId: parsed.clientId,
        redirectUri: parsed.redirectUri,
        resource: parsed.resource,
        scope: parsed.scope,
        setCookie: consent.headers.has('set-cookie'),
      });
      return html(consentHtml(info, consent.handle), consent.headers);
    }
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return new Response('Invalid form', { status: 415, headers: safeHeaders });
      stage = 'readConsentForm';
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      console.log('OAuth consent POST received', {
        decision: String(form.get('decision') ?? ''),
        handleLength: handle.length,
        cookieNames: cookieNames(request),
        hasConsentCookie: cookieNames(request).some(name => name.startsWith('__Host-oauth-consent-')),
      });
      if (form.get('decision') === 'deny') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (form.get('decision') !== 'approve') return new Response('Invalid decision', { status: 400, headers: safeHeaders });
      stage = 'approveConsent';
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      if (!isChatGptCimd(approved.request.clientId)) return new Response('Unsupported OAuth request', { status: 400, headers: safeHeaders });
      stage = 'completeAuthorization';
      const complete = await oauth.completeAuthorization({
        request: approved.request,
        userId: 'debug-owner',
        metadata: { debugMode: true },
        scope: approved.request.scope,
        props: { owner: true, debugMode: true },
      });
      console.log('OAuth authorization completed', { clientId: approved.request.clientId, redirectUri: approved.request.redirectUri, resource: approved.request.resource });
      approved.headers.set('Location', complete.redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response('Method not allowed', { status: 405, headers: { ...safeHeaders, allow: 'GET, POST' } });
  } catch (error) {
    console.error('OAuth authorization failure', {
      stage,
      method: request.method,
      path: new URL(request.url).pathname,
      cookieNames: cookieNames(request),
      error: errorForLog(error),
    });
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) {
      return new Response(`OAuth debug failure at ${stage}: ${error.description ?? error.message}`, { status: 400, headers: safeHeaders });
    }
    if (error instanceof CimdFetchError) {
      return new Response(`OAuth CIMD failure at ${stage}: ${error.reason}: ${error.detail}`, { status: 400, headers: safeHeaders });
    }
    return new Response(`Authorization unavailable at ${stage}`, { status: 503, headers: safeHeaders });
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
    } catch (error) {
      console.error('Skill2Plugin request failed', errorForLog(error));
      return new Response('Service unavailable', { status: 503, headers: safeHeaders });
    }
  },
};
