#!/usr/bin/env node
// Evolve Health storage node. No dependencies beyond Node.js 22.
//
//   node node/server.mjs                       # node only, on http://127.0.0.1:8787
//   node node/server.mjs --app web --host 0.0.0.0 --data /var/lib/evolve-health
//
// --app also serves the web app itself, so one process (or `docker compose up`) is a complete
// self-hosted Evolve Health. Browsers only allow the app's encryption on https:// or localhost,
// so put a LAN or internet deployment behind HTTPS (see node/README.md).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { StorageNode, NODE_VERSION } from '../web/src/node/core.mjs';
import { FsKV } from './fs-kv.mjs';

export const APP_CSP = [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self' blob:",
  "media-src 'self' blob:", "connect-src 'self' https: http://localhost:* http://127.0.0.1:*", "worker-src 'self'",
  "manifest-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'none'", "require-trusted-types-for 'script'", 'trusted-types evolve-health',
].join('; ');
export const PERMISSIONS = 'camera=(), geolocation=(), microphone=(self), payment=(), usb=(), interest-cohort=()';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

export function createServer({ dataDir, app, allowOrigin = '*', log = false, rateLimit = 1200, ...config }) {
  const node = new StorageNode({ kv: new FsKV(resolve(dataDir)), config: { ...config, onError: (e) => console.error(e) } });
  const appRoot = app ? resolve(app) : null;
  const buckets = new Map();
  const maxBody = node.config.maxShareBytes + 1024 * 1024;

  function allowed(ip) {
    const now = Date.now();
    const b = buckets.get(ip) || { tokens: rateLimit, at: now };
    b.tokens = Math.min(rateLimit, b.tokens + ((now - b.at) / 60000) * rateLimit);
    b.at = now;
    buckets.set(ip, b);
    if (buckets.size > 10000) buckets.clear();
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function cors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, eh-expires, eh-node-code');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'eh-expires');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBody) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async function serveApp(req, res, pathname) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    let file = resolve(appRoot, rel);
    if (file !== appRoot && !file.startsWith(appRoot + sep)) { res.writeHead(404).end(); return; }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      const type = MIME[extname(file)] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': APP_CSP, 'Permissions-Policy': PERMISSIONS, 'Cross-Origin-Opener-Policy': 'same-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://node');
    const started = Date.now();
    res.on('finish', () => { if (log) console.log(`${req.method} ${url.pathname.split('/').slice(0, 3).join('/')} ${res.statusCode} ${Date.now() - started}ms`); });
    try {
      if (url.pathname.startsWith('/v1/')) {
        cors(req, res);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (!allowed(req.socket.remoteAddress || '')) { res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"error":"Too many requests"}'); return; }
        const out = await node.handle({ method: req.method, path: url.pathname + url.search, headers: req.headers, body: await readBody(req) });
        for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
        if (out.bytes) res.writeHead(out.status, { 'Content-Type': 'application/octet-stream' }).end(out.bytes);
        else res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.json));
        return;
      }
      if (appRoot && (req.method === 'GET' || req.method === 'HEAD')) { await serveApp(req, res, url.pathname); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Evolve Health node ${NODE_VERSION}. API under /v1/.`);
    } catch (err) {
      if (!res.headersSent) res.writeHead(err.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.status ? err.message : 'Internal error' }));
      if (!err.status) console.error(err);
    }
  });
}

function main() {
  const env = process.env;
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: env.EH_PORT || '8787' },
      host: { type: 'string', default: env.EH_HOST || '127.0.0.1' },
      data: { type: 'string', default: env.EH_DATA || './evolve-health-data' },
      name: { type: 'string', default: env.EH_NAME || 'Evolve Health node' },
      registration: { type: 'string', default: env.EH_REGISTRATION || 'open' },
      code: { type: 'string', multiple: true, default: (env.EH_CODES || '').split(',').filter(Boolean) },
      'quota-mb': { type: 'string', default: env.EH_QUOTA_MB || '2048' },
      app: { type: 'string', default: env.EH_APP || '' },
      'allow-origin': { type: 'string', default: env.EH_ALLOW_ORIGIN || '*' },
      log: { type: 'boolean', default: env.EH_LOG === '1' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: node node/server.mjs [--port 8787] [--host 127.0.0.1] [--data DIR] [--app web] [--registration open|code --code SECRET] [--quota-mb 2048] [--log]');
    return;
  }
  if (!['open', 'code'].includes(values.registration)) throw new Error('--registration must be open or code');
  if (values.registration === 'code' && !values.code.length) throw new Error('--registration code needs at least one --code');
  const server = createServer({
    dataDir: values.data, app: values.app || null, allowOrigin: values['allow-origin'], log: values.log,
    name: values.name, registration: values.registration, registrationCodes: values.code,
    quotaBytes: Number(values['quota-mb']) * 1024 * 1024,
  });
  server.listen(Number(values.port), values.host, () => {
    const where = `http://${values.host === '0.0.0.0' ? 'localhost' : values.host}:${values.port}`;
    console.log(`Evolve Health node ${NODE_VERSION} on ${where} (data in ${resolve(values.data)})`);
    if (values.app) console.log(`App: ${where}/`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
