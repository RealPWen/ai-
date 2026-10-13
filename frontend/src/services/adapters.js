/**
 * ONLY this layer translates backend responses to frontend view models.
 * The shapes below are frontend needs, not mandatory backend API contracts.
 * Change these functions when actual response examples arrive.
 */
const unwrap = response => response && typeof response === 'object' && Object.hasOwn(response, 'data') ? response.data : response;
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}返回格式不符`);
  return value;
};
const array = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label}应返回列表`);
  return value;
};
const finite = (value, label) => {
  if (value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${label}应为数字或 null`);
  return value ?? null;
};

export const adapters = {
  profile(response) {
    const data = unwrap(response);
    if (data == null) return null;
    const item = object(data, '公司信息');
    return { name: item.name, ticker: item.ticker, description: item.description, businesses: array(item.businesses ?? [], '业务分类'), sourceUrl: item.sourceUrl };
  },
  quote(response) {
    const data = unwrap(response);
    if (data == null) return null;
    const item = object(data, '行情快照');
    return { price: finite(item.price, '股价'), currency: item.currency, asOf: item.asOf, peTtm: finite(item.peTtm, 'PE-TTM'), pb: finite(item.pb, 'PB') };
  },
  prices(response) {
    const data = unwrap(response);
    return data == null ? [] : array(data, '价格序列').map(item => {
      object(item, '价格记录');
      if (!item.date || typeof item.close !== 'number' || !Number.isFinite(item.close) || item.close <= 0) throw new Error('价格记录缺少有效日期或收盘价');
      return { date: item.date, value: item.close };
    });
  },
  debates(response) {
    const data = unwrap(response);
    return data == null ? [] : array(data, '核心分歧').map(item => {
      object(item, '分歧记录');
      if (!item.title) throw new Error('分歧记录缺少标题');
      return { title: item.title, summary: item.summary, metrics: array(item.metrics ?? [], '验证指标'), perspectives: array(item.perspectives ?? [], '观点'), sources: array(item.sources ?? [], '来源'), asOf: item.asOf };
    });
  },
  forecasts(response) {
    const data = unwrap(response);
    return data == null ? [] : array(data, 'EPS 情景').map(item => {
      object(item, 'EPS 情景记录');
      if (!item.fiscalYear) throw new Error('EPS 情景缺少财年');
      for (const name of ['low', 'consensus', 'high']) if (item[name]) { object(item[name], 'EPS'); finite(item[name].value, 'EPS'); }
      if (item.sampleSize != null && (!Number.isInteger(item.sampleSize) || item.sampleSize < 0)) throw new Error('EPS 样本数无效');
      return item;
    });
  },
  bands(response) {
    const data = unwrap(response);
    if (data == null) return null;
    object(data, '估值 band');
    const read = name => {
      const group = data[name];
      if (group == null) return null;
      object(group, '估值序列');
      const points = array(group.points ?? [], '估值点位').map(item => {
        if (!item.date || typeof item.value !== 'number' || !Number.isFinite(item.value)) throw new Error('估值点位无效');
        return { date: item.date, value: item.value };
      });
      return { points, source: group.source, asOf: group.asOf };
    };
    return { peTtm: read('peTtm'), pb: read('pb') };
  },
  events(response) {
    const data = unwrap(response);
    return data == null ? [] : array(data, '事件').map(item => {
      object(item, '事件记录');
      if (!item.title || !item.publishedAt) throw new Error('事件缺少标题或发布时间');
      return { title: item.title, category: item.category, publishedAt: item.publishedAt, summary: item.summary, impact: item.impact, verification: item.verification, source: item.source, sourceUrl: item.sourceUrl, readingScope: item.readingScope };
    });
  },
};
