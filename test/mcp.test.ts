import { describe, expect, it } from 'vitest';
import { handleMcp } from '../src/mcp.ts';
import type { Env } from '../src/types.ts';

function env(): Env {
  const catalog = { skills: [{ uri: 'skill://skill2plugin/demo/SKILL.md', frontmatter: { name: 'demo', description: 'Demo' }, resources: [{ uri: 'skill://skill2plugin/demo/SKILL.md', digest: 'sha256:abc', asset: '/_content/files/1', mimeType: 'text/plain; charset=utf-8' }] }] };
  const contents = new Map([['/_content/catalog.json', JSON.stringify(catalog)], ['/_content/files/1', '# Demo']]);
  return { PUBLIC_ORIGIN: 'https://example.workers.dev', ASSETS: { fetch: async (request: Request) => new Response(contents.get(new URL(request.url).pathname), { status: contents.has(new URL(request.url).pathname) ? 200 : 404 }) } as Fetcher } as Env;
}

const call = (method: string, params: object = {}) => new Request('https://example.workers.dev/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

describe('MCP Skill extension', () => {
  it('advertises only skills, lists entries, and reads exact resources', async () => {
    const environment = env();
    const init = await (await handleMcp(call('initialize'), environment)).json() as any;
    expect(init.result.capabilities).toEqual({ extensions: { 'io.modelcontextprotocol/skills': {} } });
    const listing = await (await handleMcp(call('skills/list'), environment)).json() as any;
    expect(listing.result.skills).toHaveLength(1);
    const read = await (await handleMcp(call('resources/read', { uri: listing.result.skills[0].uri }), environment)).json() as any;
    expect(read.result.contents[0].text).toBe('# Demo');
    expect((await (await handleMcp(call('tools/list'), environment)).json() as any).result.tools).toEqual([]);
  });

  it('refuses unknown resources and tool calls', async () => {
    const environment = env();
    expect((await (await handleMcp(call('resources/read', { uri: 'skill://skill2plugin/demo/../../secret' }), environment)).json() as any).error.code).toBe(-32602);
    expect((await (await handleMcp(call('tools/call', { name: 'shell' }), environment)).json() as any).error.code).toBe(-32601);
  });
});
