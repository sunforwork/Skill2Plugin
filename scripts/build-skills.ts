import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, join, posix, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BlobReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { parseDocument } from 'yaml';

const MAX_SKILLS = 5;
const MAX_FILES = 100;
const MAX_SKILL_MD = 256 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_SKILL = 5 * 1024 * 1024;
const MAX_ARCHIVE = 8 * 1024 * 1024;
const MAX_ZIP = 32 * 1024 * 1024;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv', '.svg', '.html', '.css', '.js', '.ts', '.py', '.sh', '.xml']);

export interface BuiltResource { uri: string; digest: string; asset: string; mimeType: string; }
export interface BuiltSkill { uri: string; frontmatter: Record<string, unknown>; resources: BuiltResource[]; }
export interface Catalog { skills: BuiltSkill[]; }
type InputFile = { path: string; bytes: Uint8Array };

function validPath(input: string): string {
  if (!input || input.includes('\\') || input.startsWith('/') || input.includes('\0') || /[\u0000-\u001f]/.test(input)) throw new Error(`Unsafe path: ${input}`);
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || /[<>:"|?*]/.test(part))) throw new Error(`Unsafe path: ${input}`);
  return input;
}

function checkFile(path: string, bytes: Uint8Array): void {
  if (bytes.byteLength > (path === 'SKILL.md' ? MAX_SKILL_MD : MAX_FILE)) throw new Error(`${path}: file exceeds import limit`);
}

async function directoryFiles(base: string): Promise<InputFile[]> {
  const files: InputFile[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const stats = await lstat(full);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw new Error(`Unsupported file: ${full}`);
      if (stats.isDirectory()) await visit(full);
      else {
        const path = validPath(relative(base, full).split(sep).join('/'));
        if (stats.size > MAX_FILE) throw new Error(`${path}: file exceeds import limit`);
        files.push({ path, bytes: new Uint8Array(await readFile(full)) });
      }
      if (files.length > MAX_FILES) throw new Error('Skill has too many files');
    }
  }
  await visit(base);
  return files;
}

async function archiveFiles(archive: string, password?: string): Promise<InputFile[]> {
  const stats = await lstat(archive);
  if (!stats.isFile() || stats.size > MAX_ZIP) throw new Error(`${archive}: ZIP is too large`);
  const reader = new ZipReader(new BlobReader(new Blob([new Uint8Array(await readFile(archive))])));
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_FILES + 20) throw new Error(`${archive}: too many ZIP entries`);
    const files: InputFile[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const entry of entries) {
      const name = validPath(entry.directory ? entry.filename.replace(/\/$/, '') : entry.filename);
      const key = name.normalize('NFC').toLowerCase();
      if (seen.has(key)) throw new Error(`${archive}: duplicate ZIP path`);
      seen.add(key);
      const type = (entry.unixMode ?? 0) & 0o170000;
      if (type && type !== (entry.directory ? 0o040000 : 0o100000)) throw new Error(`${archive}: link or special file`);
      if (entry.directory) continue;
      if (entry.encrypted && entry.zipCrypto) throw new Error(`${archive}: use AES ZIP encryption, not ZipCrypto`);
      if (entry.encrypted && !password) throw new Error(`${archive}: SKILLS_ZIP_PASSWORD is required`);
      if (entry.uncompressedSize > MAX_FILE) throw new Error(`${archive}: ${name} exceeds file limit`);
      total += entry.uncompressedSize;
      if (total > MAX_SKILL) throw new Error(`${archive}: extracted content exceeds skill limit`);
      let bytes: Uint8Array;
      try { bytes = await entry.getData(new Uint8ArrayWriter(), { password }); }
      catch { throw new Error(`${archive}: unable to decrypt or read ${name}`); }
      files.push({ path: name, bytes });
      if (files.length > MAX_FILES) throw new Error(`${archive}: too many files`);
    }
    const roots = new Set(files.map(file => file.path.split('/')[0]));
    if (roots.size === 1 && files.every(file => file.path.includes('/'))) {
      const prefix = [...roots][0] + '/';
      files.forEach(file => { file.path = file.path.slice(prefix.length); });
    }
    return files;
  } finally { await reader.close(); }
}

function metadata(bytes: Uint8Array, expected: string): Record<string, unknown> {
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error(`${expected}: SKILL.md needs YAML frontmatter`);
  const parsed = parseDocument(match[1], { uniqueKeys: true });
  if (parsed.errors.length) throw new Error(`${expected}: invalid YAML frontmatter`);
  const value = parsed.toJS();
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${expected}: frontmatter must be a map`);
  if (value.name !== expected || typeof value.description !== 'string' || !value.description.trim()) throw new Error(`${expected}: name must match directory and description must be present`);
  return value;
}

function mime(path: string): string {
  const ext = posix.extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return ext === '.svg' ? 'image/svg+xml' : 'text/plain; charset=utf-8';
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf', '.webp': 'image/webp' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

export async function build(inputRoot: string, outputRoot: string, password?: string): Promise<Catalog> {
  let excluded = new Set<string>();
  try {
    const ignore = await readFile(join(inputRoot, '.exampleignore'), 'utf8');
    excluded = new Set(ignore.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(validPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const inputs = (await readdir(inputRoot, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.') && !excluded.has(entry.name));
  if (!inputs.length || inputs.length > MAX_SKILLS) throw new Error(`Expected 1–${MAX_SKILLS} Skills`);
  const catalog: Catalog = { skills: [] };
  const output = new Map<string, Uint8Array>();
  const zip = new ZipWriter(new Uint8ArrayWriter());
  const names = new Set<string>();
  try {
    for (const entry of inputs) {
      const isZip = entry.isFile() && entry.name.toLowerCase().endsWith('.zip');
      if (!entry.isDirectory() && !isZip) throw new Error(`Unsupported Skills entry: ${entry.name}`);
      const name = isZip ? entry.name.slice(0, -4) : entry.name;
      if (!NAME.test(name) || names.has(name)) throw new Error(`Invalid or duplicate Skill name: ${name}`);
      names.add(name);
      const full = join(inputRoot, entry.name);
      const files = isZip ? await archiveFiles(full, password) : await directoryFiles(full);
      const skillMd = files.find(file => file.path === 'SKILL.md');
      if (!skillMd) throw new Error(`${name}: SKILL.md missing`);
      const frontmatter = metadata(skillMd.bytes, name);
      let total = 0;
      const resources: BuiltResource[] = [];
      const fileNames = new Set<string>();
      for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
        validPath(file.path);
        const folded = file.path.normalize('NFC').toLowerCase();
        if (fileNames.has(folded)) throw new Error(`${name}: duplicate path ${file.path}`);
        fileNames.add(folded);
        checkFile(file.path, file.bytes);
        total += file.bytes.byteLength;
        if (total > MAX_SKILL) throw new Error(`${name}: skill exceeds total import limit`);
        const uri = `skill://skill2plugin/${name}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
        const digest = `sha256:${createHash('sha256').update(file.bytes).digest('hex')}`;
        const asset = `/_content/files/${createHash('sha256').update(uri).digest('hex')}`;
        output.set(asset, file.bytes);
        resources.push({ uri, digest, asset, mimeType: mime(file.path) });
        await zip.add(`${name}/${file.path}`, new Uint8ArrayReader(file.bytes));
      }
      catalog.skills.push({ uri: resources.find(r => r.uri.endsWith('/SKILL.md'))!.uri, frontmatter, resources });
    }
    const archive = await zip.close();
    if (archive.byteLength > MAX_ARCHIVE) throw new Error('Combined Skill archive exceeds 8 MiB import limit');
    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(join(outputRoot, 'assets', '_content', 'files'), { recursive: true });
    for (const [asset, bytes] of output) await writeFile(join(outputRoot, 'assets', asset), bytes);
    await writeFile(join(outputRoot, 'assets', '_content', 'catalog.json'), JSON.stringify(catalog));
    return catalog;
  } catch (error) {
    await zip.close().catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  build(resolve('Skills'), resolve('.generated'), process.env.SKILLS_ZIP_PASSWORD)
    .then(catalog => console.log(`Built ${catalog.skills.length} Skill(s)`))
    .catch(error => { console.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
