// File-system key-value store for the self-hosted node. Keys map to files under the data directory
// (JSON as .json, file chunks as .bin); writes go to a temporary file and are renamed into place.
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const SAFE = /^[A-Za-z0-9_\-/]+$/;

export class FsKV {
  constructor(root) { this.root = root; }
  path(key, ext) {
    if (!SAFE.test(key) || key.includes('..') || key.startsWith('/')) throw new Error(`Unsafe key ${key}`);
    return join(this.root, `${key}${ext}`);
  }
  async write(file, data) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  }
  async read(file) {
    try { return await readFile(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  async getJSON(k) { const b = await this.read(this.path(k, '.json')); return b ? JSON.parse(b.toString('utf8')) : null; }
  async putJSON(k, v) { await this.write(this.path(k, '.json'), JSON.stringify(v)); }
  async getBytes(k) { const b = await this.read(this.path(k, '.bin')); return b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null; }
  async putBytes(k, v) { await this.write(this.path(k, '.bin'), v); }
  async has(k) {
    for (const ext of ['.json', '.bin']) {
      try { await stat(this.path(k, ext)); return true; } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    return false;
  }
  async del(k) { for (const ext of ['.json', '.bin']) await rm(this.path(k, ext), { force: true }); }
  async list(prefix) {
    // Prefixes always end at a directory boundary ("ops/<space>/", "share/").
    const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : dirname(prefix);
    let names;
    try { names = await readdir(join(this.root, dir)); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return names.filter((n) => /\.(json|bin)$/.test(n)).map((n) => `${dir}/${n.replace(/\.(json|bin)$/, '')}`)
      .filter((k) => k.startsWith(prefix)).sort();
  }
}
