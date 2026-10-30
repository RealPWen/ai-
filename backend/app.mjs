import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { ResearchError } from './src/errors.mjs';
const defaultOrigins = ['http://127.0.0.1:8765', 'http://localhost:8765'];
function safeDiagnostic(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  if (['authorization', 'models', 'responses', 'stream', 'request'].includes(value.stage)) result.stage = value.stage;
  for (const [key, max] of [['elapsedMs', 600000], ['curlExitCode', 100], ['httpStatus', 599]]) {
    if (Number.isInteger(value[key]) && value[key] >= (key === 'httpStatus' ? 100 : 0) && value[key] <= max) result[key] = value[key];
  }
  if (['application/json', 'text/html', 'text/plain', 'text/event-stream', 'missing', 'unknown'].includes(value.mime)) result.mime = value.mime;
  return Object.keys(result).length ? result : undefined;
}
async function jsonBody(request, maxBytes = 16384) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new ResearchError('CONTENT_TYPE_REQUIRED', '请使用 application/json 请求', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ResearchError('BODY_TOO_LARGE', '请求内容过大', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ResearchError('INVALID_JSON', '请求不是有效 JSON', 400); }
}
export function createResearchServer({ service, health, auth, aiStatus, chatClient, marketService, forecastService, relationsService, relationsManualService, relationsAiService, newsService, attributionService, watchlistStore, notesStore, watchlistAttributionRuntime, relationAttributionService, allowedOrigins = defaultOrigins }) {
  const callbackOrigins = new Map();
  const safeHTML = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const callbackPage = (response, { ok, message, targetOrigin }) => {
    const nonce = randomBytes(18).toString('base64');
    const origin = allowedOrigins.includes(targetOrigin) ? targetOrigin : defaultOrigins[0];
    const title = ok ? 'ChatGPT 套餐授权成功' : 'ChatGPT 登录未完成';
    response.writeHead(ok ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
    });
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><style>body{font:16px/1.8 system-ui;margin:60px auto;max-width:600px;padding:24px;color:#18372f}a{color:#147d75}p{color:#617b72}</style><h1>${title}</h1><p>${safeHTML(message)}</p><p>点击“返回看板”继续。看板会重新检查登录状态。</p><a href="${origin}/#debates">返回看板</a><script nonce="${nonce}">history.replaceState(null,'','/auth/callback');if(window.opener){window.opener.postMessage({type:'chatgpt-auth-complete'},${JSON.stringify(origin)});}</script></html>`);
  };
  return http.createServer(async (request, response) => {
    const send = (status, body) => { if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); } };
    try {
      // Local service only. No frontend assets or .env are served here.
      const host = request.headers.host?.split(':')[0];
      if (!['127.0.0.1', 'localhost'].includes(host)) throw new ResearchError('HOST_NOT_ALLOWED', '仅允许本机访问', 403);
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/auth/callback' && auth) {
        const state = url.searchParams.get('state');
        const targetOrigin = callbackOrigins.get(state)?.origin;
        callbackOrigins.delete(state);
        try { await auth.callback(url.searchParams); return callbackPage(response, { ok: true, message: '本项目已获得 ChatGPT 套餐用量授权。先测试连接，再生成核心市场分歧。', targetOrigin }); }
        catch (error) { return callbackPage(response, { ok: false, message: error instanceof ResearchError ? error.message : '本次登录处理失败，请回到看板重新登录。', targetOrigin }); }
      }
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) throw new ResearchError('ORIGIN_NOT_ALLOWED', '当前网页来源未获准调用本地后端', 403);
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      if (request.method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return send(204, null); }
      if (url.pathname.startsWith('/api/relations/attribution') && relationAttributionService) {
        if(request.method==='GET'&&url.pathname==='/api/relations/attribution')return send(200,{data:await relationAttributionService.get(Object.fromEntries(url.searchParams))});
        if(request.method==='POST'&&url.pathname==='/api/relations/attribution/generate')return send(202,{data:await relationAttributionService.start(await jsonBody(request))});
        if(request.method==='GET'&&url.pathname.startsWith('/api/relations/attribution/jobs/'))return send(200,{data:await relationAttributionService.getJob(url.pathname.split('/').at(-1))});
        if(url.pathname==='/api/relations/attribution/batch'){
          if(request.method==='POST'){await jsonBody(request);relationAttributionService.triggerAll();return send(202,{data:relationAttributionService.status()});}
          if(request.method==='GET')return send(200,{data:relationAttributionService.status()});
        }
      }
      if (url.pathname === '/api/watchlist/attributions' && watchlistAttributionRuntime) {
        if(request.method==='GET')return send(200,{data:watchlistAttributionRuntime.snapshot()});
        if(request.method==='POST') {await jsonBody(request);watchlistAttributionRuntime.trigger();return send(202,{data:watchlistAttributionRuntime.snapshot()});}
      }
      if (url.pathname === '/api/watchlist' && ['GET','POST'].includes(request.method)) {
        if (!watchlistStore) throw new ResearchError('DATABASE_UNAVAILABLE', '自选数据库暂不可用', 503);
        if (request.method === 'GET') return send(200, { data: await watchlistStore.list(url.searchParams.get('owner')) });
        return send(200, { data: await watchlistStore.change(await jsonBody(request, 65536)) });
      }
      if (url.pathname === '/api/notes' && ['GET', 'POST'].includes(request.method)) {
        if (!notesStore) throw new ResearchError('DATABASE_UNAVAILABLE', '笔记数据库暂不可用', 503);
        if (request.method === 'GET') return send(200, { data: await notesStore.get(Object.fromEntries(url.searchParams)) });
        return send(200, { data: await notesStore.save(await jsonBody(request, 400000)) });
      }
      if (aiStatus && request.method === 'GET' && url.pathname === '/api/auth/status') return send(200, { data: await aiStatus() });
      if (auth && request.method === 'GET' && url.pathname === '/api/auth/status') return send(200, { data: { ...await auth.status(), provider: 'chatgpt' } });
      if (auth && request.method === 'POST' && url.pathname === '/api/auth/chatgpt/start') {
        await jsonBody(request);
        for (const [key, value] of callbackOrigins) if (value.expiresAt < Date.now()) callbackOrigins.delete(key);
        const result = await auth.start();
        callbackOrigins.set(new URL(result.url).searchParams.get('state'), { origin: origin || defaultOrigins[0], expiresAt: Date.parse(result.expiresAt) });
        if (callbackOrigins.size > 10) callbackOrigins.delete(callbackOrigins.keys().next().value);
        return send(200, { data: result });
      }
      if (auth && request.method === 'POST' && url.pathname === '/api/auth/logout') { await jsonBody(request); callbackOrigins.clear(); await auth.logout(); return send(200, { data: { authenticated: false } }); }
      if (chatClient && request.method === 'GET' && url.pathname === '/api/auth/models') return send(200, { data: await chatClient.models() });
      if (chatClient && request.method === 'POST' && url.pathname === '/api/auth/test') { await jsonBody(request); return send(200, { data: await chatClient.probe() }); }
      if (request.method === 'GET' && url.pathname === '/api/health') return send(200, { data: health });
      if (url.pathname === '/api/market/attribution' && request.method === 'GET') {
        if (!attributionService) throw new ResearchError('ATTRIBUTION_DATABASE_NOT_CONFIGURED', '涨跌归因数据库尚未配置。', 503);
        return send(200, { data: await attributionService.get(Object.fromEntries(url.searchParams)) });
      }
      const attributionJob = /^\/api\/market\/attribution\/jobs\/([^/]+)$/.exec(url.pathname);
      if (attributionJob && request.method === 'GET') {
        if (!attributionService) throw new ResearchError('ATTRIBUTION_DATABASE_NOT_CONFIGURED', '涨跌归因数据库尚未配置。', 503);
        if (url.search) throw new ResearchError('INVALID_PARAMETERS', '任务查询不接受额外参数。', 400);
        return send(200, { data: await attributionService.getJob(attributionJob[1]) });
      }
      if (url.pathname === '/api/market/attribution/generate' && request.method === 'POST') {
        if (!attributionService) throw new ResearchError('ATTRIBUTION_DATABASE_NOT_CONFIGURED', '涨跌归因数据库尚未配置。', 503);
        const address = request.socket.remoteAddress || '';
        if (!(address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address))) throw new ResearchError('LOCAL_ONLY_OPERATION', '归因生成仅允许在服务器本机操作。', 403);
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new ResearchError('ORIGIN_NOT_ALLOWED', '当前网页来源未获准生成归因。', 403);
        if (url.search) throw new ResearchError('INVALID_PARAMETERS', '归因生成参数应放在 JSON 请求中。', 400);
        return send(202, { data: await attributionService.start(await jsonBody(request)) });
      }
      if (request.method === 'GET' && url.pathname === '/api/forecasts') {
        if (!forecastService) throw new ResearchError('FORECAST_DATABASE_NOT_CONFIGURED', '卖方预测数据库尚未配置', 503);
        return send(200, { data: await forecastService.get(Object.fromEntries(url.searchParams)) });
      }
      if (request.method === 'GET' && url.pathname === '/api/relations') {
        if (!relationsService) throw new ResearchError('RELATIONS_DATABASE_NOT_CONFIGURED', '公司关系数据库尚未配置', 503);
        return send(200, { data: await relationsService.get(Object.fromEntries(url.searchParams)) });
      }
      if (url.pathname === '/api/relations/research' && ['GET', 'POST'].includes(request.method)) {
        if (!relationsAiService) throw new ResearchError('RELATIONS_AI_NOT_CONFIGURED', 'AI 关系识别服务尚未配置。', 503);
        if (request.method === 'GET') return send(200, { data: await relationsAiService.get(Object.fromEntries(url.searchParams)) });
        const address = request.socket.remoteAddress || '';
        if (!(address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address))) throw new ResearchError('LOCAL_ONLY_OPERATION', 'AI 识别仅允许在服务器本机启动。', 403);
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new ResearchError('ORIGIN_NOT_ALLOWED', '当前网页来源未获准启动 AI 识别。', 403);
        if (url.search) throw new ResearchError('INVALID_PARAMETERS', 'AI 识别参数应放在 JSON 请求中。', 400);
        return send(202, { data: await relationsAiService.start(await jsonBody(request)) });
      }
      if (request.method === 'POST' && url.pathname === '/api/relations/manual') {
        const address = request.socket.remoteAddress || '';
        if (!(address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address))) {
          throw new ResearchError('LOCAL_ONLY_OPERATION', '关系修改仅允许在服务器本机操作', 403);
        }
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new ResearchError('ORIGIN_NOT_ALLOWED', '当前网页来源未获准修改公司关系', 403);
        if (url.search) throw new ResearchError('INVALID_PARAMETERS', '关系修改参数应放在 JSON 请求中', 400);
        if (!relationsManualService) throw new ResearchError('RELATIONS_DATABASE_NOT_CONFIGURED', '公司关系数据库尚未配置', 503);
        return send(200, { data: await relationsManualService.save(await jsonBody(request, 262144)) });
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        if (!newsService) throw new ResearchError('NEWS_DATABASE_NOT_CONFIGURED', '资讯数据库尚未配置', 503);
        return send(200, { data: await newsService.get(Object.fromEntries(url.searchParams)) });
      }
      if (request.method === 'GET' && ['/api/stocks', '/api/stocks/profile', '/api/market/quote', '/api/market/prices', '/api/market/bands'].includes(url.pathname)) {
        if (!marketService) throw new ResearchError('MARKET_DATABASE_NOT_CONFIGURED', '行情数据库尚未配置', 503);
        const params = Object.fromEntries(url.searchParams);
        const method = { '/api/stocks': 'search', '/api/stocks/profile': 'profile', '/api/market/quote': 'quote', '/api/market/prices': 'prices', '/api/market/bands': 'bands' }[url.pathname];
        return send(200, { data: await marketService[method](params) });
      }
      if (request.method === 'GET' && url.pathname === '/api/debates') return send(200, { data: await service.get({ ticker: url.searchParams.get('ticker') }) });
      if (request.method === 'POST' && url.pathname === '/api/debates/generate') return send(200, { data: await service.generate(await jsonBody(request)) });
      throw new ResearchError('NOT_FOUND', '接口不存在', 404);
    } catch (error) {
      send(error instanceof ResearchError ? error.status : 500, { error: { code: error instanceof ResearchError ? error.code : 'INTERNAL_ERROR', message: error instanceof ResearchError ? error.message : '后端处理失败，请查看服务状态后重试', ...(error instanceof ResearchError && safeDiagnostic(error.diagnostic) ? { diagnostic: safeDiagnostic(error.diagnostic) } : {}) } });
    }
  });
}
