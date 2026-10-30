function positiveNumber(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestamp(value) {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Every current membership must agree before a classification can be selected.
function uniqueValue(values) {
  const distinct = new Set(values.map(text));
  return distinct.size === 1 && !distinct.has(null) ? [...distinct][0] : null;
}

/** Latest SW2021 membership; prefer a usable L3 series, then its unique L2 parent. */
export async function readIndustryBenchmark({ query, ticker, from, asOf, stockPoints }) {
  const emptyPoints = stockPoints.map(point => ({ date: point.date, close: null, scaledClose: null }));
  const benchmark = {
    status: 'unmapped', system: 'SW2021', level: 3, membershipBasis: 'latest',
    membershipFetchedAt: null, indexCode: null, industryName: null,
    classification: { l3Code: null, l3Name: null, l2Code: null, l2Name: null }, fallbackReason: null,
    baseDate: null, baseStockClose: null, baseIndexClose: null, latest: null, points: emptyPoints,
  };
  // Keep one coherent membership source for each stock. Independently queried
  // L2 members fill omissions in the L3 endpoint, without merging mismatched
  // source snapshots or hiding a genuine conflict within the selected source.
  const members = await query(`WITH preferred_members AS (
      SELECT m.l3_code, m.l3_name, m.l2_code, m.l2_name, m.fetched_at
      FROM market_data.sw_industry_members m
      WHERE m.ts_code = $1 AND m.is_new = 'Y'
    ), selected_members AS (
      SELECT * FROM preferred_members
      UNION ALL
      SELECT m.l3_code, m.l3_name, m.l2_code, m.l2_name, m.fetched_at
      FROM market_data.sw_industry_members_l2 m
      WHERE m.ts_code = $1 AND m.is_new = 'Y'
        AND NOT EXISTS (SELECT 1 FROM preferred_members)
    )
    SELECT m.l3_code AS index_code, m.l3_name AS member_industry_name,
      m.l2_code, m.l2_name AS member_l2_name, m.fetched_at AS membership_fetched_at,
      i.index_code AS catalog_index_code, i.industry_name, i.is_pub,
      i2.index_code AS l2_catalog_index_code, i2.industry_name AS l2_industry_name, i2.is_pub AS l2_is_pub
    FROM selected_members m
    LEFT JOIN market_data.sw_industries i ON i.index_code = m.l3_code AND i.src = 'SW2021'
    LEFT JOIN market_data.sw_industries_l2 i2 ON i2.index_code = m.l2_code AND i2.src = 'SW2021'
    ORDER BY m.l3_code, m.l2_code`, [ticker]);
  if (!members.rows.length) return benchmark;
  benchmark.membershipFetchedAt = members.rows.map(row => timestamp(row.membership_fetched_at)).filter(Boolean).sort().at(-1) ?? null;
  const l3Code = uniqueValue(members.rows.map(row => row.index_code));
  const l2Code = uniqueValue(members.rows.map(row => row.l2_code));
  benchmark.classification = {
    l3Code, l3Name: l3Code ? uniqueValue(members.rows.map(row => row.member_industry_name || row.industry_name)) : null,
    l2Code, l2Name: l2Code ? uniqueValue(members.rows.map(row => row.member_l2_name || row.l2_industry_name)) : null,
  };

  async function readCandidate({ level, indexCode, industryName, catalogCode, published }) {
    const candidate = { ...benchmark, level, indexCode, industryName };
    // A missing catalog row (or an unknown publication flag) is not evidence
    // that the index is unpublished.
    if (!indexCode || catalogCode !== indexCode || typeof published !== 'boolean') {
      return { ...candidate, status: 'missing_classification' };
    }
    if (!published) return { ...candidate, status: 'unpublished' };
    const prices = await query(`SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date, close
      FROM market_data.sw_index_daily
      WHERE index_code = $1 AND trade_date BETWEEN $2::date AND $3::date
      ORDER BY trade_date ASC`, [indexCode, from, asOf]);
    const byDate = new Map(prices.rows.filter(row => typeof row.trade_date === 'string'
      && row.trade_date >= from && row.trade_date <= asOf).map(row => [row.trade_date, positiveNumber(row.close)]));
    const latest = [...byDate.entries()].filter(([, close]) => close !== null)
      .sort(([left], [right]) => left.localeCompare(right)).at(-1);
    if (!latest) return { ...candidate, status: 'missing_prices' };
    // Preserve the actual last index session, including when the stock has no
    // usable sessions because of suspension or missing adjustment factors.
    candidate.latest = { date: latest[0], close: latest[1] };
    const base = stockPoints.filter(point => positiveNumber(point.close) !== null && byDate.get(point.date) != null)
      .sort((left, right) => left.date.localeCompare(right.date))[0];
    if (!base) return { ...candidate, status: 'no_common_date' };
    const baseStockClose = positiveNumber(base.close), baseIndexClose = byDate.get(base.date);
    return {
      ...candidate, status: 'available', baseDate: base.date, baseStockClose, baseIndexClose,
      points: stockPoints.map(point => {
        const close = byDate.get(point.date) ?? null;
        const scaled = close === null ? null : close / baseIndexClose * baseStockClose;
        return { date: point.date, close, scaledClose: Number.isFinite(scaled) ? scaled : null };
      }),
    };
  }

  const member = members.rows[0];
  const l3 = l3Code ? await readCandidate({ level: 3, indexCode: l3Code,
    industryName: text(member.industry_name) || benchmark.classification.l3Name,
    catalogCode: member.catalog_index_code, published: member.is_pub })
    : { ...benchmark, status: members.rows.some(row => text(row.index_code)) ? 'ambiguous_membership' : 'missing_classification' };
  if (l3.status === 'available' || !l2Code) return l3;

  const l2 = await readCandidate({ level: 2, indexCode: l2Code,
    industryName: text(member.l2_industry_name) || benchmark.classification.l2Name,
    catalogCode: member.l2_catalog_index_code, published: member.l2_is_pub });
  // If neither index can be aligned to stock dates, retain existing L3 index
  // data instead of replacing it with an equally unusable or empty L2 series.
  if (l3.latest && l2.status !== 'available') return l3;
  return { ...l2, fallbackReason: l3.status };
}
