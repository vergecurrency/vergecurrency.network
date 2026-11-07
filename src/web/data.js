'use strict';

const { schemas } = require('../schema');
const DAY = 86_400_000;
const definitions = ['hashpower', 'difficulty'].map((key) => ({ key, database: 'verge', measurement: key, host: 'verge', fields: Object.keys(schemas.verge[key]) }));

class PublicError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseRange(search, now = Date.now()) {
  for (const name of search.keys()) {
    if (!['from', 'to', 'bucket'].includes(name) || search.getAll(name).length !== 1) throw new PublicError(400, 'Use only from, to, and bucket once each.');
  }
  function parse(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new PublicError(400, 'Dates must use ISO UTC format.');
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new PublicError(400, 'Invalid date.');
    return timestamp;
  }
  const from = search.has('from') ? parse(search.get('from')) : now - DAY;
  const to = search.has('to') ? parse(search.get('to')) : now;
  if (search.has('from') !== search.has('to')) throw new PublicError(400, 'Provide both from and to dates.');
  if (from < 0 || to <= from || to > now + 300_000 || to - from > 20 * 366 * DAY) throw new PublicError(400, 'Choose an ordered date range of up to 20 years, ending no later than now.');
  const grouping = search.get('bucket') ?? 'auto';
  if (!['auto', 'hour', 'day', 'month'].includes(grouping)) throw new PublicError(400, 'Choose Auto, Hour, Day, or Month grouping.');
  if (grouping === 'hour' && to - from > 31 * DAY) throw new PublicError(400, 'Hourly grouping supports up to 31 days. Choose Daily or Monthly.');
  if (grouping === 'day' && to - from > 744 * DAY) throw new PublicError(400, 'Daily grouping supports up to 744 days. Choose Monthly.');
  const intervalMs = grouping === 'hour' ? 3_600_000 : ['day', 'month'].includes(grouping) ? DAY : Math.max(60_000, Math.ceil((to - from) / 360 / 60_000) * 60_000);
  return { from, to, intervalMs, grouping };
}

function statementsFor(definition, range) {
  const { measurement, fields } = definition;
  const where = `time >= '${new Date(range.from).toISOString()}' AND time <= '${new Date(range.to).toISOString()}' AND "host" = 'verge'`;
  const monthly = range.grouping === 'month';
  const select = fields.map((field) => monthly ? `SUM("${field}"::float) AS "${field}_sum",COUNT("${field}") AS "${field}_count"` : `MEAN("${field}") AS "${field}"`).join(',');
  const limit = monthly ? 7322 : range.grouping === 'auto' ? 362 : 746;
  return [
    `SELECT ${select} FROM "${measurement}" WHERE ${where} GROUP BY time(${range.intervalMs / 1000}s) fill(null) LIMIT ${limit}`,
    `SELECT ${fields.map((field) => `"${field}"`).join(',')} FROM "${measurement}" WHERE ${where} ORDER BY time DESC LIMIT 1`,
  ];
}

function rows(result, definition, limit, range) {
  if (result?.error) throw new Error('Algorithm query failed');
  const output = [];
  for (const series of result?.series ?? []) {
    if (!Array.isArray(series.columns) || !Array.isArray(series.values)) continue;
    for (const values of series.values) {
      const timestamp = values[series.columns.indexOf('time')];
      if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) continue;
      const row = { time: range ? Math.max(range.from, Math.min(range.to, timestamp)) : timestamp };
      for (const field of definition.fields) {
        const value = values[series.columns.indexOf(field)];
        row[field] = typeof value === 'number' && Number.isFinite(value) ? value : null;
      }
      output.push(row);
      if (output.length >= limit) return output;
    }
  }
  return output;
}

function monthlyRows(result, definition, range) {
  const fields = definition.fields.flatMap((field) => [field + '_sum', field + '_count']);
  const daily = rows(result, { fields }, 7322);
  const months = new Map();
  for (const row of daily) {
    const date = new Date(row.time);
    const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const entry = months.get(month) ?? Object.fromEntries(definition.fields.map((field) => [field, { sum: 0, count: 0 }]));
    for (const field of definition.fields) {
      if (Number.isFinite(row[field + '_sum']) && row[field + '_count'] > 0) {
        entry[field].sum += row[field + '_sum'];
        entry[field].count += row[field + '_count'];
      }
    }
    months.set(month, entry);
  }
  return [...months].sort(([a], [b]) => a - b).map(([time, values]) => ({
    time: Math.max(range.from, time),
    ...Object.fromEntries(definition.fields.map((field) => [field, values[field].count ? values[field].sum / values[field].count : null])),
  }));
}

function createDataReader(influx, { now = Date.now, logger = console } = {}) {
  const cache = new Map();
  const pending = new Map();
  let historyCache;
  let historyPending;
  async function history() {
    if (historyCache && historyCache.expires > now()) return historyCache.value;
    if (historyPending) return historyPending;
    historyPending = (async () => {
      try {
        const queries = definitions.flatMap(({ measurement, fields }) => ['ASC', 'DESC'].map((order) => `SELECT "${fields[0]}" FROM "${measurement}" WHERE "host" = 'verge' ORDER BY time ${order} LIMIT 1`));
        const result = await influx.query('verge', queries);
        const times = result.map((part, index) => rows(part, definitions[Math.floor(index / 2)], 1)[0]?.time);
        const starts = times.filter((time, index) => index % 2 === 0 && Number.isFinite(time));
        const ends = times.filter((time, index) => index % 2 === 1 && Number.isFinite(time));
        const value = starts.length && ends.length ? { from: Math.min(...starts), to: Math.max(...ends) } : null;
        historyCache = { expires: now() + 60_000, value };
        return value;
      } catch { historyCache = { expires: now() + 15_000, value: null }; return null; }
    })().finally(() => { historyPending = null; });
    return historyPending;
  }
  async function load(range) {
    let result;
    try { result = await influx.query('verge', definitions.flatMap((definition) => statementsFor(definition, range))); }
    catch (error) { logger.error(`[public charts] ${error.message}`); throw new PublicError(503, 'Statistics are temporarily unavailable. Please try again shortly.'); }
    const datasets = {};
    let successes = 0;
    definitions.forEach((definition, index) => {
      try {
        if (!result[index * 2] || !result[index * 2 + 1]) throw new Error('Incomplete query response');
        datasets[definition.key] = {
          points: range.grouping === 'month' ? monthlyRows(result[index * 2], definition, range) : rows(result[index * 2], definition, range.grouping === 'auto' ? 362 : 746, range),
          latest: rows(result[index * 2 + 1], definition, 1)[0] ?? null, available: true,
        };
        successes++;
      } catch { datasets[definition.key] = { points: [], latest: null, available: false }; }
    });
    if (!successes) throw new PublicError(503, 'Statistics are temporarily unavailable. Please try again shortly.');
    const availableRange = await history();
    const times = Object.values(datasets).map((dataset) => dataset.latest?.time).filter(Number.isFinite);
    return { mode: 'live', generatedAt: new Date(now()).toISOString(), range, availableRange, datasets, partial: successes < 2, latestObservedAt: times.length ? Math.max(...times) : null };
  }
  return {
    async read(range) {
      const key = `${range.from}:${range.to}:${range.intervalMs}:${range.grouping}`;
      const hit = cache.get(key);
      if (hit && hit.expires > now()) return hit.value;
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 4) throw new PublicError(429, 'Statistics are busy. Please try again shortly.');
      const promise = load(range).then((value) => {
        cache.delete(key); cache.set(key, { expires: now() + 30_000, value });
        while (cache.size > 48) cache.delete(cache.keys().next().value);
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    },
  };
}

module.exports = { definitions, PublicError, parseRange, statementsFor, monthlyRows, createDataReader };
