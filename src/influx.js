'use strict';

const { request, json, basicAuth } = require('./http');
const { schemas } = require('./schema');

function escapeName(value, measurement = false) {
  const text = String(value);
  if (!text || /[\r\n]/.test(text)) throw new Error('Invalid InfluxDB measurement, tag, or field name');
  return text.replace(measurement ? /[ ,]/g : /[ ,=]/g, '\\$&');
}

function encodePoint(database, { measurement, tags, fields, timestamp }) {
  const schema = schemas[database]?.[measurement];
  if (!schema) throw new Error('Unknown InfluxDB database or measurement');
  const tagPairs = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    if (key !== 'host' && !(key === 'source' && value === 'backfill')) throw new Error('Unknown InfluxDB tag');
    return `${escapeName(key)}=${escapeName(value)}`;
  });
  const fieldPairs = [];
  for (const [key, value] of Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Object.hasOwn(schema, key)) throw new Error(`Unknown InfluxDB field ${measurement}.${key}`);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected a finite number for ${measurement}.${key}`);
    let encoded = String(value);
    if (schema[key] === 'integer') {
      // Match the old node-influx client's Math.floor conversion.
      const integer = BigInt(Math.floor(value));
      if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) throw new Error(`Integer outside InfluxDB range for ${measurement}.${key}`);
      encoded = `${integer}i`;
    }
    fieldPairs.push(`${escapeName(key)}=${encoded}`);
  }
  if (!fieldPairs.length) throw new Error(`No numeric fields available for ${measurement}`);
  // Explicit timestamps are Unix milliseconds; live samples still use server time.
  if (timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 9_223_372_036_854)) {
    throw new Error('InfluxDB timestamp must be a valid nonnegative Unix millisecond integer');
  }
  return `${escapeName(measurement, true)}${tagPairs.length ? ',' + tagPairs.join(',') : ''} ${fieldPairs.join(',')}${timestamp === undefined ? '' : ` ${timestamp}`}`;
}

function createInflux(config, fetchImpl = fetch) {
  const headers = config.user ? { authorization: basicAuth(config.user, config.password) } : {};
  const endpoint = (route) => new URL(`${config.url.href.replace(/\/$/, '')}/${route}`);
  return {
    async query(database, statements) {
      const url = endpoint('query');
      url.searchParams.set('db', database);
      url.searchParams.set('q', statements.join(';'));
      url.searchParams.set('epoch', 'ms');
      const response = await request(url, { headers }, config.timeoutMs, fetchImpl);
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error(`InfluxDB query failed (HTTP ${response.status})`);
      }
      const body = await json(response, 'InfluxDB');
      if (body?.error || !Array.isArray(body?.results)) throw new Error('InfluxDB query returned an error');
      return body.results;
    },
    async write(database, points) {
      const body = points.map((point) => encodePoint(database, point)).join('\n');
      if (!body) throw new Error('Cannot write an empty InfluxDB batch');
      const url = endpoint('write');
      url.searchParams.set('db', database);
      if (points.some((point) => point.timestamp !== undefined)) url.searchParams.set('precision', 'ms');
      const response = await request(url, {
        method: 'POST', headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }, body,
      }, config.timeoutMs, fetchImpl);
      const detail = await response.text();
      if (!response.ok) throw new Error(`InfluxDB write to ${database} failed (HTTP ${response.status}): ${detail.slice(0, 500)}`);
    },
    async databases() {
      const url = endpoint('query');
      url.searchParams.set('q', 'SHOW DATABASES');
      const response = await request(url, { headers }, config.timeoutMs, fetchImpl);
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error(`InfluxDB check failed (HTTP ${response.status})`);
      }
      const body = await json(response, 'InfluxDB');
      const failure = body?.error ?? body?.results?.find((result) => result.error)?.error;
      if (failure) throw new Error(`InfluxDB check failed: ${failure}`);
      if (!Array.isArray(body?.results)) throw new Error('InfluxDB returned an invalid database list');
      return body.results.flatMap((result) => (result.series ?? []).flatMap((series) => (series.values ?? []).map(([name]) => name)));
    },
  };
}

module.exports = { createInflux, encodePoint };
