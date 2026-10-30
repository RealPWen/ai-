import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { normalizeTradeDate } from './postgres-store.mjs';

const ENDPOINT = 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php';
const MAX_BYTES = 2 * 1024 * 1024;
const runFile = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const tidy = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const compact = value => tidy(value).replace(/\s/gu, '');

export class EtnetHkForecastError extends Error {
  constructor(message, { kind = 'invalid_response', retryable = false, curlExitCode } = {}) {
    super(message); this.name = 'EtnetHkForecastError'; this.kind = kind; this.retryable = retryable;
    if (Number.isInteger(curlExitCode) && curlExitCode >= 0 && curlExitCode <= 100) this.curlExitCode = curlExitCode;
  }
}
const invalid = message => new EtnetHkForecastError(message);
const configuration = () => new EtnetHkForecastError('经济通港股卖方预测代码、日期范围或客户端配置无效。', { kind: 'configuration' });
function rangeOf({ ticker, startDate, endDate } = {}) {
  if (typeof ticker !== 'string' || !/^\d{5}\.HK$/.test(ticker)) throw configuration();
  let start, end;
  try { start = normalizeTradeDate(startDate); end = normalizeTradeDate(endDate); } catch { throw configuration(); }
  const days = (Date.parse(`${end.iso}T00:00:00Z`) - Date.parse(`${start.iso}T00:00:00Z`)) / 86400000 + 1;
  // Snapshot runs include today as well as the same date one year ago;
  // a leap-year span can therefore contain 367 inclusive calendar dates.
  if (days < 1 || days > 367) throw configuration();
  return { ticker, code: ticker.slice(0, 5), start, end };
}
function decimal(text) {
  const value = compact(text);
  if (['', '--', '-', '—', 'N/A'].includes(value)) return null;
  if (value.length > 64 || !/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(value)) throw invalid('经济通每股盈利不是有效数值或明确缺失值。');
  const number = Number(value.replaceAll(',', ''));
  if (!Number.isFinite(number)) throw invalid('经济通每股盈利超出有效数值范围。');
  return number;
}
function unitOf(header, profitHeader) {
  const text = compact(header);
  const units = [
    ['人民币元', 'CNY', 1], ['人民幣元', 'CNY', 1], ['港元', 'HKD', 1], ['美元', 'USD', 1],
    ['港仙', 'HKD', 100], ['美仙', 'USD', 100], ['便士', 'GBP', 100], ['欧仙', 'EUR', 100],
    ['歐仙', 'EUR', 100], ['澳仙', 'AUD', 100], ['加仙', 'CAD', 100], ['分', 'CNY', 100],
  ];
  const parentheticals = [...text.matchAll(/[（(]([^()（）]+)[）)]/g)].map(match => match[1]);
  for (const [unit, currency, divisor] of units) if (parentheticals.includes(unit)) {
    // “分” alone cannot establish a reporting currency. Require the monetary
    // column in this same forecast table to explicitly identify RMB.
    if (unit === '分' && (!/人民币|人民幣/.test(compact(profitHeader)) || /港元|美元|英镑|英鎊|欧元|歐元|澳元|加元|日元|日圆|日圓/.test(compact(profitHeader)))) return { unit, currency: null, divisor: null };
    return { unit, currency, divisor };
  }
  // An unlabelled or unfamiliar cent must never silently become HKD or CNY.
  return { unit: parentheticals.at(-1) ?? null, currency: null, divisor: null };
}
function dateOf(text) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(tidy(text));
  if (!match) throw invalid('经济通证券商更新日期格式无效。');
  try { return normalizeTradeDate(`${match[3]}${match[2]}${match[1]}`).compact; }
  catch { throw invalid('经济通证券商更新日期无效。'); }
}
function tableGrid($, table) {
  const carry = new Map(), grid = [];
  $(table).find('tr').filter((_, row) => $(row).closest('table')[0] === table).each((_, row) => {
    const cells = [], next = new Map();
    for (const [column, value] of carry) { cells[column] = value.text; if (value.remaining > 1) next.set(column, { ...value, remaining: value.remaining - 1 }); }
    let column = 0;
    $(row).children('td,th').each((_, cell) => {
      while (cells[column] !== undefined) column++;
      const text = tidy($(cell).text()), colspan = Number($(cell).attr('colspan') ?? 1), rowspan = Number($(cell).attr('rowspan') ?? 1);
      if (![colspan, rowspan].every(value => Number.isInteger(value) && value > 0 && value <= 100)) throw invalid('经济通预测表格跨行或跨列结构无效。');
      for (let offset = 0; offset < colspan; offset++) {
        cells[column + offset] = text;
        if (rowspan > 1) next.set(column + offset, { text, remaining: rowspan - 1 });
      }
      column += colspan;
    });
    carry.clear(); for (const entry of next) carry.set(...entry);
    if (cells.some(text => tidy(text))) grid.push(cells);
  });
  return grid;
}

/** Parse only the broker overview, never the site's composite/consensus table. */
export function parseEtnetHkForecastHtml(html, options) {
  const range = rangeOf(options);
  if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html) > MAX_BYTES || !/<\/html\s*>/i.test(html)) throw invalid('经济通返回的 HTML 缺失、过大或不完整。');
  const $ = load(html), title = tidy($('title').text()), titleCode = /^(\d{5})(?:\s|$)/.exec(title)?.[1];
  if (titleCode !== range.code) throw invalid('经济通页面股票代码与请求不一致。');
  const candidates = [];
  $('table').each((_, table) => {
    const grid = tableGrid($, table), index = grid.findIndex(cells => cells.some(text => /证券商|證券商/.test(text))
      && cells.some(text => /每股盈利/.test(text)) && cells.some(text => /更新日期/.test(text)));
    if (index >= 0) candidates.push({ grid, index });
  });
  if (candidates.length !== 1) {
    // Sidebar widgets also say “暂无资料”; only the earnings module can
    // establish a successful empty forecast snapshot. The whole module must
    // be an explicit empty state, not one rating/sidebar panel inside it.
    const earningsModules = $('.DivFigureContent');
    const emptyModule = earningsModules.length === 1 && !earningsModules.find('aside,[role="complementary"],.sidebar,.sideBar').length
      ? tidy(earningsModules.text()) : '';
    const noDataEvidence = /^(暂无资料|暫無資料|没有(?:相关)?资料|沒有(?:相關)?資料|暂时没有|暫時沒有|暂未有资料|暫未有資料|No data|No forecasts)[。.！!]?$/i.exec(emptyModule)?.[1];
    if (!candidates.length && noDataEvidence) {
      const url = `${ENDPOINT}?code=${range.code}`;
      return { rows: [], source: 'etnet', apiName: 'etnet_hk_profit_forecast', sourceUrl: url,
        coverage: { kind: 'current_snapshot', dateMeaning: 'broker_update_date', historicalArchiveAvailable: false,
          sourceRows: 0, rowsInRange: 0, noDataEvidence }, raw: { html, request: { url, ticker: range.ticker,
          startDate: range.start.compact, endDate: range.end.compact }, noDataEvidence } };
    }
    throw invalid('经济通证券商盈利预测明细表缺失或重复。');
  }
  const { grid, index } = candidates[0], headers = grid[index];
  const column = pattern => headers.findIndex(text => pattern.test(compact(text)));
  const yearColumn = column(/财政年度|財政年度/), epsColumn = column(/每股盈利/), orgColumn = column(/证券商|證券商/), dateColumn = column(/更新日期/), ratingColumn = column(/评级|評級/), profitColumn = column(/纯利|純利/);
  if ([yearColumn, epsColumn, orgColumn, dateColumn].some(value => value < 0)) throw invalid('经济通盈利预测必需字段缺失。');
  const unit = unitOf(headers[epsColumn], headers[profitColumn]), pageText = compact($('body').text());
  const adjusted = /每股盈利.{0,30}(?:合并|合併).{0,10}拆细|每股盈利.{0,30}(?:合并|合併).{0,10}拆細/.test(pageText);
  const epsBasis = adjusted ? '来源每股盈利（按合股、拆细及红股调整）' : null;
  const url = `${ENDPOINT}?code=${range.code}`, rows = [], seen = new Map();
  let sourceRows = 0, missingEps = 0, outsideRange = 0;
  for (const cells of grid.slice(index + 1)) {
    if (cells.every(text => !tidy(text))) continue;
    if (cells.length !== headers.length) throw invalid('经济通预测明细行列数与字段不一致。');
    const fiscalLabel = tidy(cells[yearColumn]), yearMatch = /^(?:(\d{1,2})\/)?(\d{4})$/.exec(fiscalLabel);
    if (!yearMatch || (yearMatch[1] && (+yearMatch[1] < 1 || +yearMatch[1] > 12)) || +yearMatch[2] < 1990 || +yearMatch[2] > 2200) throw invalid('经济通预测财政年度无效。');
    const fiscalYear = +yearMatch[2], fiscalPeriod = yearMatch[1] ? `${yearMatch[2]}-${yearMatch[1].padStart(2, '0')}` : yearMatch[2], org = tidy(cells[orgColumn]);
    if (!org || ['--', '-'].includes(org) || org.length > 200) throw invalid('经济通证券商名称缺失或无效。');
    const reportDate = dateOf(cells[dateColumn]), rawEps = decimal(cells[epsColumn]);
    sourceRows++; if (rawEps === null) missingEps++;
    if (reportDate < range.start.compact || reportDate > range.end.compact) { outsideRange++; continue; }
    // Parse the shifted decimal directly so e.g. 243.30 cents serializes as
    // 2.433 instead of accumulating a binary-division tail in PostgreSQL.
    const eps = rawEps === null || unit.divisor === null ? null : unit.divisor === 1 ? rawEps
      : Number(`${compact(cells[epsColumn]).replaceAll(',', '')}e-2`);
    const identity = [range.ticker, org, fiscalPeriod, reportDate, unit.currency, epsBasis];
    const sourceRecordId = `etnet:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
    const rating = ratingColumn < 0 || ['', '--', '-'].includes(cells[ratingColumn]) ? null : tidy(cells[ratingColumn]);
    const rawData = { headers, cells, fiscal_year_label: fiscalLabel, eps: cells[epsColumn], eps_unit: unit.unit,
      eps_divisor: unit.divisor, currency: unit.currency, date_meaning: 'broker_update_date', eps_basis: epsBasis };
    const row = { ts_code: range.ticker, report_date: reportDate, org_name: org, fiscal_year: fiscalYear, fiscal_period: fiscalPeriod, eps,
      currency: unit.currency, eps_basis: epsBasis, source_record_id: sourceRecordId,
      report_title: null, author_name: null, np: null, pe: null, rating, source_url: url, raw_data: rawData };
    if (seen.has(sourceRecordId)) {
      if (JSON.stringify(seen.get(sourceRecordId)) !== JSON.stringify(row)) throw invalid('经济通同一证券商、财政年度和更新日期存在冲突预测。');
      continue;
    }
    seen.set(sourceRecordId, row); rows.push(row);
  }
  return { rows, source: 'etnet', apiName: 'etnet_hk_profit_forecast', sourceUrl: url,
    coverage: { kind: 'current_snapshot', dateMeaning: 'broker_update_date', historicalArchiveAvailable: false,
      sourceRows, rowsInRange: rows.length, outsideRange, missingEps, currency: unit.currency, rawEpsUnit: unit.unit,
      fiscalYearMeaning: 'source_fiscal_year_label', unknownUnitRows: unit.divisor === null ? rows.length : 0,
      ...(sourceRows === 0 ? { noDataEvidence: 'identified_broker_overview_table_has_no_data_rows' } : {}) },
    raw: { html, request: { url, ticker: range.ticker, startDate: range.start.compact, endDate: range.end.compact },
      methodology: { table: 'broker_forecast_overview_only', date: 'broker_update_date_not_assumed_report_publication_date',
        history: 'current_broker_snapshot_only_daily_archiving_starts_at_first_collection',
        eps: 'source_reported_eps_with_explicit_minor_currency_unit_divided_by_100',
        missingUnit: 'null_eps_and_null_currency_raw_value_preserved', accountingBasis: 'no_gaap_or_adjusted_earnings_inference',
        corporateActions: adjusted ? 'upstream_adjusts_for_share_consolidation_split_and_bonus' : 'not_specified' },
      units: unit, headers } };
}

function proxyEnvironment(source) {
  const result = {};
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    const value = source?.[name.toLowerCase()] ?? source?.[name];
    if (!value) continue;
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw configuration();
    if (name !== 'NO_PROXY') {
      let url; try { url = new URL(value); } catch { throw configuration(); }
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw configuration();
    }
    result[name.toLowerCase()] = value;
  }
  return result;
}
function curlFetch({ timeoutMs, proxyEnv, runFileImpl }) {
  const env = proxyEnvironment(proxyEnv);
  return async (url, { signal, tlsCompatibility = false }) => {
    // The caller constructs this fixed URL. No arbitrary host, redirects, shell,
    // curlrc, auth header or disabled certificate verification is supported.
    if (!/^https:\/\/www\.etnet\.com\.hk\/www\/sc\/stocks\/realtime\/quote_profit\.php\?code=\d{5}$/.test(url)) throw configuration();
    let stdout;
    try {
      ({ stdout } = await runFileImpl('/usr/bin/curl', ['-q', '--http1.1',
        ...(tlsCompatibility ? ['--tlsv1.2'] : ['--tls-max', '1.2']), '--ipv4', '--proto', '=https',
        '--max-redirs', '0', '--max-time', String(Math.ceil(timeoutMs / 1000)), '--connect-timeout', '20',
        '--max-filesize', String(MAX_BYTES), '--silent', '--show-error', '--user-agent', 'Mozilla/5.0',
        '--write-out', '\n__ETNET_STATUS__%{http_code}', '--url', url], { shell: false, signal, env, maxBuffer: MAX_BYTES + 100 }));
    } catch (error) {
      throw new EtnetHkForecastError(signal.aborted || error?.code === 28 ? '经济通港股卖方预测请求超时。' : '无法连接经济通港股卖方预测服务。',
        { kind: signal.aborted || error?.code === 28 ? 'timeout' : 'network', retryable: true, curlExitCode: error?.code });
    }
    const marker = /\n__ETNET_STATUS__(\d{3})$/.exec(stdout);
    if (!marker) throw invalid('经济通 HTTP 状态缺失。');
    return { status: Number(marker[1]), async text() { return stdout.slice(0, marker.index); } };
  };
}

/** Current broker snapshots; no endpoint here claims to expose past revisions. */
export function createEtnetHkForecastClient({ fetchImpl, intervalMs = 2000, timeoutMs = 120000,
  maxRetries = 2, retryBaseMs = 2000, sleep = wait, now = Date.now, proxyEnv = process.env, runFileImpl = runFile, concurrency = 1 } = {}) {
  if ((fetchImpl !== undefined && typeof fetchImpl !== 'function') || typeof sleep !== 'function' || typeof now !== 'function'
    || typeof runFileImpl !== 'function'
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3
    || !Number.isInteger(intervalMs) || intervalMs < 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000
    || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5 || !Number.isInteger(retryBaseMs) || retryBaseMs < 0) throw configuration();
  const fetchPage = fetchImpl ?? curlFetch({ timeoutMs, proxyEnv, runFileImpl });
  const startIntervalMs = concurrency > 1 ? Math.max(intervalMs, 2000) : intervalMs;
  const waiting = [];
  let startGate = Promise.resolve(), lastStarted = -Infinity, active = 0, stopped = null;
  function startRequest() {
    const pending = startGate.then(async () => {
      if (stopped) throw stopped;
      const pause = Math.max(0, lastStarted + startIntervalMs - now()); if (pause) await sleep(pause);
      if (stopped) throw stopped;
      lastStarted = now();
    });
    startGate = pending.catch(() => {});
    return pending;
  }
  async function collectRange(range) {
    const url = `${ENDPOINT}?code=${range.code}`;
    let tlsCompatibility = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await startRequest();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); let failure;
      try {
        const response = await fetchPage(url, { method: 'GET', redirect: 'error', signal: controller.signal, tlsCompatibility, headers: { Accept: 'text/html' } });
        if (!response || !Number.isInteger(response.status)) throw invalid('经济通 HTTP 响应结构无效。');
        if (response.status === 429) {
          stopped = new EtnetHkForecastError('经济通请求频率受限，本次采集已停止，请稍后重试。', { kind: 'rate_limit' });
          throw stopped;
        }
        if (response.status === 403) {
          stopped = new EtnetHkForecastError('经济通拒绝本次访问，采集已停止，请稍后检查访问状态。', { kind: 'permission' });
          throw stopped;
        }
        if (response.status >= 500) throw new EtnetHkForecastError('经济通服务暂时不可用或请求频率受限。', { kind: 'upstream', retryable: true });
        if (response.status < 200 || response.status >= 300) throw new EtnetHkForecastError('经济通 HTTP 请求失败或重定向。', { kind: 'http' });
        return parseEtnetHkForecastHtml(await response.text(), { ticker: range.ticker, startDate: range.start.compact, endDate: range.end.compact });
      } catch (error) {
        failure = error instanceof EtnetHkForecastError ? error : new EtnetHkForecastError(controller.signal.aborted ? '经济通港股卖方预测请求超时。' : '无法连接经济通港股卖方预测服务。', { kind: controller.signal.aborted ? 'timeout' : 'network', retryable: true });
      } finally { clearTimeout(timer); }
      if (!failure.retryable || attempt === maxRetries) throw failure;
      // A transient curl TLS handshake failure can be specific to the 1.2
      // ceiling. The next existing retry permits system negotiation at TLS
      // 1.2 or newer; certificate verification and attempt bounds stay intact.
      tlsCompatibility = failure.curlExitCode === 35;
      await sleep(Math.min(30000, retryBaseMs * 2 ** attempt));
    }
  }
  function pump() {
    while (active < concurrency && waiting.length) {
      const task = waiting.shift(); active++;
      collectRange(task.range).then(task.resolve, task.reject).finally(() => { active--; pump(); });
    }
  }
  return { collect(options) {
    let range;
    try { range = rangeOf(options); } catch (error) { return Promise.reject(error instanceof EtnetHkForecastError ? error : configuration()); }
    if (stopped) return Promise.reject(stopped);
    return new Promise((resolve, reject) => { waiting.push({ range, resolve, reject }); pump(); });
  } };
}
