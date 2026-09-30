import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { build } from '../scripts/build-skills.ts';

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function setup(): Promise<{ root: string; skills: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skill2plugin-'));
  temporary.push(root);
  const skills = join(root, 'Skills');
  await mkdir(skills);
  return { root, skills, output: join(root, '.generated') };
}

const markdown = (name: string) => `---\nname: ${name}\ndescription: Example for ${name}\n---\n# Example\n`;
async function archive(path: string, files: Record<string, Uint8Array | string>, password?: string) {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, data] of Object.entries(files)) {
    await writer.add(name, new Uint8ArrayReader(typeof data === 'string' ? new TextEncoder().encode(data) : data), password ? { password, encryptionStrength: 3 } : {});
  }
  await writeFile(path, await writer.close());
}

describe('Skill build', () => {
  it('builds directories and ZIPs with stable manifests and binary hashes', async () => {
    const { skills, output } = await setup();
    await mkdir(join(skills, 'one'));
    await writeFile(join(skills, 'one', 'SKILL.md'), markdown('one'));
    const picture = Uint8Array.of(0, 1, 255);
    await archive(join(skills, 'two.zip'), { 'two/SKILL.md': markdown('two'), 'two/assets/picture.png': picture });
    const catalog = await build(skills, output);
    expect(catalog.skills.map(skill => skill.frontmatter.name)).toEqual(['one', 'two']);
    const resource = catalog.skills[1].resources.find(item => item.mimeType === 'image/png')!;
    expect(resource.digest).toBe(`sha256:${createHash('sha256').update(picture).digest('hex')}`);
    expect(new Uint8Array(await readFile(join(output, 'assets', resource.asset)))).toEqual(picture);
  });

  it('requires the correct password for AES ZIP', async () => {
    const { skills, output } = await setup();
    await archive(join(skills, 'secret.zip'), { 'SKILL.md': markdown('secret') }, 'correct horse battery staple');
    await expect(build(skills, output)).rejects.toThrow('SKILLS_ZIP_PASSWORD');
    await expect(build(skills, output, 'wrong')).rejects.toThrow('unable to decrypt');
    expect((await build(skills, output, 'correct horse battery staple')).skills).toHaveLength(1);
  });

  it('fails clearly on oversize input and rejects duplicate names', async () => {
    const { skills, output } = await setup();
    await archive(join(skills, 'big.zip'), { 'SKILL.md': markdown('big'), 'manual.pdf': new Uint8Array(1024 * 1024 + 1) });
    await expect(build(skills, output)).rejects.toThrow('exceeds file limit');
    await rm(join(skills, 'big.zip'));
    await mkdir(join(skills, 'same'));
    await writeFile(join(skills, 'same', 'SKILL.md'), markdown('same'));
    await archive(join(skills, 'same.zip'), { 'SKILL.md': markdown('same') });
    await expect(build(skills, output)).rejects.toThrow('duplicate Skill name');
  });

  it('keeps explicit example ZIPs in Skills without building them', async () => {
    const { skills, output } = await setup();
    await mkdir(join(skills, 'one'));
    await writeFile(join(skills, 'one', 'SKILL.md'), markdown('one'));
    await writeFile(join(skills, '.exampleignore'), 'example.zip\n');
    await archive(join(skills, 'example.zip'), { 'SKILL.md': markdown('example'), 'manual.pdf': new Uint8Array(1024 * 1024 + 1) });
    expect((await build(skills, output)).skills).toHaveLength(1);
  });
});
