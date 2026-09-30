import type { Catalog, BuiltResource, BuiltSkill } from '../scripts/build-skills.ts';
import type { Env } from './types.ts';

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const LEGACY_PROTOCOL_FALLBACK = '2025-06-18';
const SERVER_INFO = { name: 'skill2plugin', version: '0.1.0' };
const CAPABILITIES = { resources: {}, extensions: { 'io.modelcontextprotocol/skills': {} } };
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' };

type Message = { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };

function modernRequest(request: Request, message: Message): boolean {
  if (request.headers.get('MCP-Protocol-Version') === MODERN_PROTOCOL_VERSION) return true;
  if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return false;
  const meta = (message.params as Record<string, unknown>)._meta;
  return !!meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] === MODERN_PROTOCOL_VERSION;
}

function result(id: unknown, value: Record<string, unknown>, modern = false): Response {
  const payload = modern
    ? {
        resultType: 'complete',
        ...value,
        _meta: {
          ...((value._meta && typeof value._meta === 'object' && !Array.isArray(value._meta)) ? value._meta as Record<string, unknown> : {}),
          'io.modelcontextprotocol/serverInfo': SERVER_INFO,
        },
      }
    : value;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: payload }), { headers });
}

function error(id: unknown, code: number, message: string, data?: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }), { headers });
}

async function asset(request: Request, env: Env, path: string): Promise<Response> {
  return env.ASSETS.fetch(new Request(new URL(path, request.url)));
}

async function catalog(request: Request, env: Env): Promise<Catalog> {
  const response = await asset(request, env, '/_content/catalog.json');
  if (!response.ok) throw new Error('catalog_unavailable');
  return response.json<Catalog>();
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404, headers });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'POST' } });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return new Response('JSON required', { status: 415, headers });

  let message: Message;
  try { message = await request.json(); }
  catch { return error(null, -32700, 'Parse error'); }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(null, -32600, 'Invalid request');
  if (message.method.startsWith('notifications/')) return new Response(null, { status: 202, headers });

  const id = message.id ?? null;
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params as Record<string, unknown> : {};
  const modern = modernRequest(request, message);
  const requestedProtocol = request.headers.get('MCP-Protocol-Version');
  const supportedProtocols = [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, LEGACY_PROTOCOL_FALLBACK];
  if (requestedProtocol && !supportedProtocols.includes(requestedProtocol)) {
    return error(id, -32022, 'Unsupported protocol version', { requested: requestedProtocol, supported: supportedProtocols });
  }

  if (message.method === 'server/discover') return result(id, {
    supportedVersions: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, LEGACY_PROTOCOL_FALLBACK],
    capabilities: CAPABILITIES,
    instructions: 'Publishes authenticated private Skills. This server exposes no MCP tools or actions.',
    ttlMs: 3600000,
    cacheScope: 'private',
  }, true);

  if (message.method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const protocolVersion = requested === LEGACY_PROTOCOL_FALLBACK ? LEGACY_PROTOCOL_FALLBACK : LEGACY_PROTOCOL_VERSION;
    return result(id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
  }

  if (message.method === 'ping') return result(id, {}, modern);
  if (message.method === 'tools/list') return result(id, { tools: [] }, modern);
  if (message.method === 'tools/call') return error(id, -32601, 'Method not found');
  if (!['skills/list', 'skills/get', 'resources/read'].includes(message.method)) return error(id, -32601, 'Method not found');

  let data: Catalog;
  try { data = await catalog(request, env); }
  catch { return error(id, -32603, 'Skill catalog unavailable'); }

  if (message.method === 'skills/list') {
    if (params.cursor !== undefined) return error(id, -32602, 'Invalid cursor');
    return result(id, {
      skills: data.skills.map(({ uri, frontmatter, resources }) => ({ uri, frontmatter, resources: resources.map(({ uri, digest }) => ({ uri, digest })) })),
      ...(modern ? { ttlMs: 3600000, cacheScope: 'private' } : {}),
    }, modern);
  }

  if (typeof params.uri !== 'string') return error(id, -32602, 'URI required');
  if (message.method === 'skills/get') {
    const skill = data.skills.find((item: BuiltSkill) => item.uri === params.uri);
    return skill
      ? result(id, { skill: { uri: skill.uri, frontmatter: skill.frontmatter, resources: skill.resources.map(({ uri, digest }) => ({ uri, digest })) } }, modern)
      : error(id, -32602, 'Unknown Skill');
  }

  const resource = data.skills.flatMap((skill: BuiltSkill) => skill.resources).find((item: BuiltResource) => item.uri === params.uri);
  if (!resource) return error(id, -32602, 'Unknown resource');
  const response = await asset(request, env, resource.asset);
  if (!response.ok) return error(id, -32603, 'Resource unavailable');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (resource.mimeType.includes('charset=utf-8') || resource.mimeType === 'image/svg+xml') {
    try {
      return result(id, {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }],
        ...(modern ? { ttlMs: 3600000, cacheScope: 'private' } : {}),
      }, modern);
    } catch { return error(id, -32603, 'Invalid resource encoding'); }
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return result(id, {
    contents: [{ uri: resource.uri, mimeType: resource.mimeType, blob: btoa(binary) }],
    ...(modern ? { ttlMs: 3600000, cacheScope: 'private' } : {}),
  }, modern);
}
