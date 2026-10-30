import { createServer, request as httpRequest } from 'node:http';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function inside(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function hidden(root, target) {
  return relative(root, target).split(sep).some(part => part.startsWith('.'));
}

function fixedBackend(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Backend origin must be a local HTTP origin.');
  }
  return url;
}

function machineHosts() {
  return new Set(['localhost', '127.0.0.1', '[::1]', ...Object.values(networkInterfaces()).flat()
    .filter(Boolean).map(({ address }) => isIP(address) === 6 ? `[${address.toLowerCase()}]` : address)]);
}

const loopback = address => address === '::1' || /^127\./.test(address ?? '') || /^::ffff:127\./i.test(address ?? '');

function validHost(request, server, hosts, publicOrigin) {
  const value = request.headers.host;
  if (typeof value !== 'string' || /[\s@/#?\\]/u.test(value)) return null;
  let origin;
  try { origin = new URL(`http://${value}`); } catch { return null; }
  if (publicOrigin && loopback(request.socket.remoteAddress) && origin.host === new URL(publicOrigin).host) return publicOrigin;
  const port = Number(origin.port || 80);
  if (!hosts.has(origin.hostname) || port !== server.address()?.port) return null;
  return origin.origin;
}

function sendJSON(request, response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text), 'X-Content-Type-Options': 'nosniff' });
  response.end(request.method === 'HEAD' ? undefined : text);
}

function proxyAPI(request, response, target, path = request.url) {
  // Neither the request Host, forwarding headers nor URL parameters select this destination.
  const headers = { host: target.host };
  for (const name of ['accept', 'content-type', 'content-length']) {
    if (request.headers[name] !== undefined) headers[name] = request.headers[name];
  }
  const upstream = httpRequest({ hostname: target.hostname, port: Number(target.port || 80),
    path, method: request.method === 'HEAD' ? 'GET' : request.method, headers }, incoming => {
    const forwarded = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    for (const name of ['content-type', 'content-length']) if (incoming.headers[name]) forwarded[name] = incoming.headers[name];
    response.writeHead(incoming.statusCode, forwarded);
    if (request.method === 'HEAD') { incoming.resume(); incoming.on('end', () => response.end()); }
    else incoming.pipe(response);
    incoming.on('error', () => response.destroy());
  });
  // Research generation can take several minutes; connection failures still return immediately.
  upstream.setTimeout(420000, () => upstream.destroy());
  upstream.on('error', () => {
    if (response.destroyed) return;
    if (response.headersSent) return response.destroy();
    sendJSON(request, response, 502, { error: { code: 'BACKEND_UNAVAILABLE', message: '后端暂时不可用，请稍后重试。' } });
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
}

/** Local and LAN pages use the same API permissions through the fixed backend. */
export function createFrontendServer({ root = DEFAULT_ROOT, backendOrigin = 'http://127.0.0.1:8000', proxyEnabled = true,
  basePath = '', publicOrigin = '', } = {}) {
  basePath = basePath.replace(/\/$/, '');
  if (basePath && !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(basePath)) throw new Error('Invalid frontend base path.');
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Public origin must contain only scheme, host and optional port.');
    publicOrigin = url.origin;
  }
  const directory = resolve(root);
  const target = fixedBackend(backendOrigin), hosts = machineHosts();
  const server = createServer(async (request, response) => {
    const sendError = (status, message, headers = {}) => {
      const body = `${message}\n`;
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff', ...headers });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const requestOrigin = validHost(request, server, hosts, publicOrigin);
    if (!requestOrigin) return sendJSON(request, response, 403, { error: { code: 'HOST_NOT_ALLOWED', message: '请通过本机地址或局域网地址访问。' } });
    let pathname;
    try {
      const rawPath = request.url?.split(/[?#]/, 1)[0] ?? '';
      if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return sendError(400, 'Bad request.');
      pathname = decodeURIComponent(rawPath);
    } catch { return sendError(400, 'Bad request.'); }
    if (/[\u0000-\u001f\u007f]/u.test(pathname)) return sendError(400, 'Bad request.');
    if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return sendError(403, 'Forbidden.');
    if (basePath) {
      if (pathname === basePath) {
        response.writeHead(307, { Location: `${basePath}/${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`, 'Cache-Control': 'no-store' });
        return response.end();
      }
      if (!pathname.startsWith(`${basePath}/`)) return sendError(404, 'Not found.');
      pathname = pathname.slice(basePath.length);
    }
    if (proxyEnabled && (pathname === '/api' || pathname.startsWith('/api/'))) {
      const approvedOrigins = new Set([requestOrigin]);
      if (publicOrigin && loopback(request.socket.remoteAddress)) approvedOrigins.add(publicOrigin);
      if ((request.headers.origin && !approvedOrigins.has(request.headers.origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
        return sendJSON(request, response, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: '当前网页来源未获准访问。' } });
      }
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
        return sendError(405, 'Method not allowed.', { Allow: 'GET, HEAD, POST' });
      }
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      // Decode only the route. The original query retains its escaping and values.
      const route = pathname.split('/').map(encodeURIComponent).join('/');
      return proxyAPI(request, response, target, `${route}${query}`);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return sendError(405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    const candidate = resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!inside(directory, candidate)) return sendError(403, 'Forbidden.');
    let handle;
    try {
      const canonicalRoot = await realpath(directory), canonicalFile = await realpath(candidate);
      if (!inside(canonicalRoot, canonicalFile) || hidden(canonicalRoot, canonicalFile)) return sendError(403, 'Forbidden.');
      // Do not follow a final symlink that appeared after the canonical-path check.
      handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile()) return sendError(404, 'Not found.');
      const body = request.method === 'HEAD' ? null : await handle.readFile();
      response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(canonicalFile).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body?.length ?? stats.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(body);
    } catch (error) {
      const denied = ['EACCES', 'EPERM', 'ELOOP'].includes(error.code);
      const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
      sendError(denied ? 403 : missing ? 404 : 500, denied ? 'Forbidden.' : missing ? 'Not found.' : 'Server error.');
    } finally { if (handle) await handle.close(); }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.FRONTEND_PORT ?? 8765);
  const backendPort = Number(process.env.FRONTEND_BACKEND_PORT ?? process.env.BACKEND_PORT ?? 8000);
  const host = process.env.FRONTEND_HOST?.trim() || '127.0.0.1';
  if (![port, backendPort].every(value => Number.isInteger(value) && value >= 1 && value <= 65535)) {
    console.error('Frontend and backend ports must be integers from 1 to 65535.');
    process.exitCode = 1;
  } else if (!isIP(host) && host !== 'localhost') {
    console.error('FRONTEND_HOST must be an IP address or localhost.');
    process.exitCode = 1;
  } else {
    const server = createFrontendServer({ backendOrigin: `http://127.0.0.1:${backendPort}`,
      basePath: process.env.COMPANY_RESEARCH_BASE_PATH || '', publicOrigin: process.env.COMPANY_RESEARCH_PUBLIC_ORIGIN || '' });
    server.on('error', error => { console.error(`Frontend server failed (${error.code ?? 'server_error'}).`); process.exitCode = 1; });
    server.listen(port, host, () => console.log(`Frontend: http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`));
  }
}
