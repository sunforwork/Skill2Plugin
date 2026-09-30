import type { Catalog, BuiltResource, BuiltSkill } from '../scripts/build-skills.ts';
import type { Env } from './types.ts';

const PROTOCOL_VERSION = '2025-06-18';
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' };

function result(id: unknown, value: unknown): Response { return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: value }), { headers }); }
function error(id: unknown, code: number, message: string): Response { return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers }); }

async function asset(env: Env, path: string): Promise<Response> {
  return env.ASSETS.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`));
}

async function catalog(env: Env): Promise<Catalog> {
  const response = await asset(env, '/_content/catalog.json');
  if (!response.ok) throw new Error('catalog_unavailable');
  return response.json<Catalog>();
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404, headers });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'POST' } });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return new Response('JSON required', { status: 415, headers });
  let message: { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };
  try { message = await request.json(); }
  catch { return error(null, -32700, 'Parse error'); }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(null, -32600, 'Invalid request');
  if (message.method.startsWith('notifications/')) return new Response(null, { status: 202, headers });
  const id = message.id ?? null;
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params as Record<string, unknown> : {};
  if (message.method === 'initialize') return result(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { extensions: { 'io.modelcontextprotocol/skills': {} } },
    serverInfo: { name: 'skill2plugin', version: '0.1.0' },
  });
  if (message.method === 'ping') return result(id, {});
  if (message.method === 'tools/list') return result(id, { tools: [] });
  if (message.method === 'tools/call') return error(id, -32601, 'Method not found');
  if (!['skills/list', 'skills/get', 'resources/read'].includes(message.method)) return error(id, -32601, 'Method not found');
  let data: Catalog;
  try { data = await catalog(env); }
  catch { return error(id, -32603, 'Skill catalog unavailable'); }
  if (message.method === 'skills/list') {
    if (params.cursor !== undefined) return error(id, -32602, 'Invalid cursor');
    return result(id, { skills: data.skills.map(({ uri, frontmatter, resources }) => ({ uri, frontmatter, resources: resources.map(({ uri, digest }) => ({ uri, digest })) })) });
  }
  if (typeof params.uri !== 'string') return error(id, -32602, 'URI required');
  if (message.method === 'skills/get') {
    const skill = data.skills.find((item: BuiltSkill) => item.uri === params.uri);
    return skill ? result(id, { skill: { uri: skill.uri, frontmatter: skill.frontmatter, resources: skill.resources.map(({ uri, digest }) => ({ uri, digest })) } }) : error(id, -32602, 'Unknown Skill');
  }
  const resource = data.skills.flatMap((skill: BuiltSkill) => skill.resources).find((item: BuiltResource) => item.uri === params.uri);
  if (!resource) return error(id, -32602, 'Unknown resource');
  const response = await asset(env, resource.asset);
  if (!response.ok) return error(id, -32603, 'Resource unavailable');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (resource.mimeType.includes('charset=utf-8') || resource.mimeType === 'image/svg+xml') {
    try { return result(id, { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }] }); }
    catch { return error(id, -32603, 'Invalid resource encoding'); }
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return result(id, { contents: [{ uri: resource.uri, mimeType: resource.mimeType, blob: btoa(binary) }] });
}
