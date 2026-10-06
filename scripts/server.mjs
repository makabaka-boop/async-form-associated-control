/**
 * 极简零依赖静态服务器：
 *   /            -> public/index.html
 *   /<file>      -> public/<file>
 *   /workers/*   -> workers/*
 *   /data/*      -> data/*
 * 仅同源，不代理也不请求任何外部服务。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  if (decoded === '/' || decoded === '') return join(PUBLIC, 'index.html');
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  if (decoded.startsWith('/workers/')) return join(ROOT, safe);
  if (decoded.startsWith('/data/')) return join(ROOT, safe);
  return join(PUBLIC, safe);
}

const server = http.createServer(async (req, res) => {
  // 同源提交落点：表单提交到隐藏 iframe，真实 formdata 流程发生后返回纯文本。
  if ((req.url || '').split('?')[0] === '/submit-sink') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('accepted (same-origin sink)');
    return;
  }
  try {
    const filePath = resolvePath(req.url || '/');
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
    res.end(err.code === 'ENOENT' ? 'Not found' : String(err));
  }
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, () => {
  console.log(`demo server: http://localhost:${port}/`);
});
