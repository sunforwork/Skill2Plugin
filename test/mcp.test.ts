import { describe, expect, it } from 'vitest';
import { handleMcp } from '../src/mcp.ts';
import type { Env } from '../src/types.ts';

function env(): Env {
  const catalog = { skills: [{ uri: 'skill://skill2plugin/demo/SKILL.md', frontmatter: { name: 'demo', description: 'Demo' }, resources: [{ uri: 'skill://skill2plugin/demo/SKILL.md', digest: 'sha256:abc', asset: '/_content/files/1', mimeType: 'text/plain; charset=utf-8' }] }] };
  const contents = new Map([['/_content/catalog.json', JSON.stringify(catalog)], ['/_content/files/1', '# Demo']]);
  return {
    OWNER_PASSPHRASE: 'x'.repeat(32),
    OAUTH_KV: {} as KVNamespace,
    ASSETS: { fetch: async (request: Request) => new Response(contents.get(new URL(request.url).pathname), { status: contents.has(new URL(request.url).pathname) ? 200 : 404 }) } as Fetcher,
  };
}

const call = (method: string, params: object = {}, modern = false) => new Request('https://example.workers.dev/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(modern ? { 'MCP-Protocol-Version': '2026-07-28' } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } : params }),
});

describe('MCP Skill extension', () => {
  it('supports the legacy initialize flow with resources plus the Skills extension', async () => {
    const environment = env();
    const init = await (await handleMcp(call('initialize', { protocolVersion: '2025-11-25' }), environment)).json() as any;
    expect(init.result.protocolVersion).toBe('2025-11-25');
    expect(init.result.capabilities).toEqual({ resources: {}, extensions: { 'io.modelcontextprotocol/skills': {} } });
    const listing = await (await handleMcp(call('skills/list'), environment)).json() as any;
    expect(listing.result.skills).toHaveLength(1);
    const read = await (await handleMcp(call('resources/read', { uri: listing.result.skills[0].uri }), environment)).json() as any;
    expect(read.result.contents[0].text).toBe('# Demo');
    expect((await (await handleMcp(call('tools/list'), environment)).json() as any).result.tools).toEqual([]);
  });

  it('advertises the Skills extension through modern server/discover without tools', async () => {
    const environment = env();
    const discover = await (await handleMcp(call('server/discover', {}, true), environment)).json() as any;
    expect(discover.result.resultType).toBe('complete');
    expect(discover.result.supportedVersions).toContain('2026-07-28');
    expect(discover.result.capabilities).toEqual({ resources: {}, extensions: { 'io.modelcontextprotocol/skills': {} } });
    expect(discover.result.capabilities.tools).toBeUndefined();
    const listing = await (await handleMcp(call('skills/list', {}, true), environment)).json() as any;
    expect(listing.result.resultType).toBe('complete');
    expect(listing.result.skills).toHaveLength(1);
  });

  it('refuses unknown resources and tool calls', async () => {
    const environment = env();
    expect((await (await handleMcp(call('resources/read', { uri: 'skill://skill2plugin/demo/../../secret' }), environment)).json() as any).error.code).toBe(-32602);
    expect((await (await handleMcp(call('tools/call', { name: 'shell' }), environment)).json() as any).error.code).toBe(-32601);
  });
});
