import { spawn } from 'node:child_process';

const MAX_HEADERS = 64 * 1024;
const ROUTES = new Map([
  ['auth.openai.com', new Set(['/api/accounts/oauth/token', '/api/accounts/oauth/revoke', '/.well-known/jwks.json'])],
  ['api.openai.com', new Set(['/v1/models', '/v1/responses'])],
  ['api.deepseek.com', new Set(['/models', '/responses', '/v1/tools/search'])],
]);

class CurlTransportError extends Error {
  constructor(code) {
    super('The verified HTTPS transport could not complete the request.');
    this.code = code;
  }
}
const safeError = (code = 'ECONNRESET') => new CurlTransportError(code);

function abortError() {
  return new DOMException('The HTTPS request was aborted.', 'AbortError');
}

function curlError(exitCode) {
  let code = 'ECONNRESET';
  if ([5, 6].includes(exitCode)) code = 'ENOTFOUND';
  else if (exitCode === 7) code = 'ECONNREFUSED';
  else if (exitCode === 28) code = 'ETIMEDOUT';
  else if ([51, 58, 60, 77, 83, 90, 91].includes(exitCode)) code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  else if ([2, 3, 4, 48].includes(exitCode)) code = 'ERR_CURL_CONFIGURATION';
  else if (exitCode === 26) code = 'ERR_CURL_BODY';
  const error = safeError(code);
  if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 100) error.curlExitCode = exitCode;
  return error;
}

// curl config escaping is distinct from shell quoting. No shell is ever used.
function configValue(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\t', '\\t')}"`;
}

function proxyEnvironment(source) {
  const result = {};
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    const value = source?.[name.toLowerCase()] ?? source?.[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw safeError('ERR_CURL_CONFIGURATION');
    if (name !== 'NO_PROXY') {
      let url;
      try { url = new URL(value); } catch { throw safeError('ERR_CURL_CONFIGURATION'); }
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw safeError('ERR_CURL_CONFIGURATION');
    }
    result[name.toLowerCase()] = value;
  }
  return result;
}

function requestConfig(input, options) {
  let url;
  try { url = new URL(input); } catch { throw safeError('ERR_CURL_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !ROUTES.get(url.hostname)?.has(url.pathname)) throw safeError('ERR_CURL_URL');
  const method = String(options.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw safeError('ERR_CURL_METHOD');
  if (options.body !== undefined && options.body !== null && method !== 'POST') throw safeError('ERR_CURL_BODY');
  const headers = new Headers(options.headers);
  let body;
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === 'string') body = options.body;
    else if (options.body instanceof URLSearchParams) {
      body = options.body.toString();
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    } else throw safeError('ERR_CURL_BODY');
  }
  const config = [];
  for (const [name, value] of headers) {
    // The local adapter only needs these headers. In particular, callers cannot
    // override Host, transfer framing, proxy authorization or redirect behavior.
    if (!['accept', 'authorization', 'content-type'].includes(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw safeError('ERR_CURL_HEADER');
    config.push(`header = ${configValue(`${name}: ${value}`)}`);
  }
  if (body !== undefined) config.push('data-binary = "@/dev/fd/3"');
  return { url, method, body, config: `${config.join('\n')}\n` };
}

function parseHeaders(buffer) {
  const lines = buffer.toString('latin1').split(/\r?\n/);
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: ([\x20-\x7e]*))?$/.exec(lines.shift());
  if (!status) throw safeError('ERR_CURL_RESPONSE');
  const statusCode = Number(status[1]);
  if (statusCode < 100 || statusCode > 599 || statusCode === 101) throw safeError('ERR_CURL_RESPONSE');
  const headers = new Headers();
  for (const line of lines) {
    if (!line) continue;
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*)$/.exec(line);
    if (!match) throw safeError('ERR_CURL_RESPONSE');
    headers.append(match[1], match[2]);
  }
  return { status: statusCode, statusText: status[2] ?? '', headers };
}

/**
 * Limited local HTTPS fetch adapter for JSON and SSE. Tokens travel through
 * stdin, request bodies through a separate pipe, and stdout remains streamed.
 * No shared auth files, API-key fallback, curlrc, redirects or insecure TLS.
 */
export function createCurlFetch({ spawnImpl = spawn, executable = '/usr/bin/curl', proxyEnv = process.env } = {}) {
  const environment = proxyEnvironment(proxyEnv);
  return async function curlFetch(input, options = {}) {
    if (options.signal?.aborted) throw abortError();
    let request;
    try { request = requestConfig(input, options); }
    catch (error) { throw error instanceof CurlTransportError ? error : safeError('ERR_CURL_CONFIGURATION'); }
    // Explicit config matches the supported local proxy invocation rather than
    // depending on libcurl's environment/casing behavior on the host machine.
    if (environment.https_proxy) request.config += `proxy = ${configValue(environment.https_proxy)}\n`;
    if (environment.no_proxy) request.config += `noproxy = ${configValue(environment.no_proxy)}\n`;
    return new Promise((resolve, reject) => {
      let child, controller, headerBuffer = Buffer.alloc(0), headerBytes = 0;
      let resolved = false, finished = false, canceled = false, forceKillTimer;
      const signal = options.signal;
      function finish(error) {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        if (error) {
          if (!resolved) reject(error);
          else if (controller && !canceled) controller.error(error);
        } else if (controller && !canceled) controller.close();
      }
      function terminate(error) {
        finish(error);
        child?.stdin?.destroy();
        child?.stdio?.[3]?.destroy();
        child?.stdout?.resume();
        if (child) {
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
          forceKillTimer.unref?.();
        }
      }
      function abort() { terminate(abortError()); }
      function deliver(chunk) {
        if (finished || !chunk.length || !controller) return;
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize <= 0) child.stdout.pause();
      }
      function consume(chunk) {
        if (finished) return;
        if (resolved) { deliver(chunk); return; }
        try {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);
          while (!resolved) {
            const crlf = headerBuffer.indexOf('\r\n\r\n');
            const lf = headerBuffer.indexOf('\n\n');
            const end = crlf >= 0 && (lf < 0 || crlf <= lf) ? crlf : lf;
            const delimiter = end === crlf && crlf >= 0 ? 4 : 2;
            if (end < 0) {
              if (headerBytes + headerBuffer.length > MAX_HEADERS) throw safeError('ERR_CURL_HEADERS');
              return;
            }
            headerBytes += end + delimiter;
            if (headerBytes > MAX_HEADERS) throw safeError('ERR_CURL_HEADERS');
            const metadata = parseHeaders(headerBuffer.subarray(0, end));
            headerBuffer = headerBuffer.subarray(end + delimiter);
            if (metadata.status < 200) continue;
            if (metadata.status >= 300 && metadata.status < 400) throw safeError('ERR_CURL_REDIRECT');
            const noBody = metadata.status === 204 || metadata.status === 205;
            const stream = noBody ? null : new ReadableStream({
              start(value) { controller = value; },
              pull() { child.stdout.resume(); },
              cancel() { canceled = true; terminate(abortError()); },
            }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));
            const response = new Response(stream, metadata);
            Object.defineProperty(response, 'url', { value: request.url.href });
            resolved = true;
            resolve(response);
            deliver(headerBuffer);
            headerBuffer = Buffer.alloc(0);
          }
        } catch (error) { terminate(error instanceof CurlTransportError ? error : safeError('ERR_CURL_RESPONSE')); }
      }
      try {
        child = spawnImpl(executable, [
          '-q', '--http1.1', '--include', '--suppress-connect-headers',
          '--silent', '--show-error', '--no-buffer', '--proto', '=https',
          '--connect-timeout', '30', '--max-time', '330',
          '--config', '-', '--request', request.method, '--url', request.url.href,
        ], { shell: false, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { ...environment } });
        child.on('error', () => terminate(safeError('ERR_CURL_EXECUTABLE')));
        child.on('close', (code) => {
          clearTimeout(forceKillTimer);
          if (finished) return;
          if (code !== 0) finish(curlError(code));
          else if (!resolved) finish(safeError());
          else finish();
        });
        // Drain diagnostic output without recording or exposing it: curl errors
        // can include headers, credentials or private request information.
        child.stderr.on('data', () => {});
        child.stderr.on('error', () => {});
        child.stdout.on('data', consume);
        child.stdout.on('error', () => terminate(safeError()));
        child.stdin.on('error', () => {});
        child.stdio[3].on('error', () => {});
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        child.stdin.end(request.config);
        child.stdio[3].end(request.body ?? '');
      } catch { terminate(safeError('ERR_CURL_EXECUTABLE')); }
    });
  };
}
