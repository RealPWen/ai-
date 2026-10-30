import { ResearchError } from './errors.mjs';
export function todayShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function parseInput(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ResearchError('INVALID_INPUT', '请求应为 JSON 对象', 400);
  if (typeof input.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/i.test(input.ticker.trim())) throw new ResearchError('INVALID_TICKER', '请输入股票代码，例如 002920.SZ 或 02313.HK', 400);
  const ticker = input.ticker.trim().toUpperCase();
  const asOf = input.asOf ?? todayShanghai(now);
  if (!validDate(asOf) || asOf > todayShanghai(now)) throw new ResearchError('INVALID_DATE', '研究日期应为有效的 YYYY-MM-DD，且不能晚于上海时区今日', 400);
  if (input.companyName != null && (typeof input.companyName !== 'string' || input.companyName.length > 100)) throw new ResearchError('INVALID_NAME', '公司名称应为不超过 100 字的文本', 400);
  const start = new Date(`${asOf}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 89);
  return { ticker, asOf, windowStart: start.toISOString().slice(0, 10), companyName: input.companyName?.trim() || null };
}
