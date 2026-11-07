'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createInflux } = require('../src/influx');
const { loadWebConfig } = require('../src/web/config');
const { createDataReader, parseRange, monthlyRows, statementsFor, definitions } = require('../src/web/data');
const { createWebServer } = require('../src/web/server');
const NOW = Date.UTC(2026, 10, 6, 12), DAY = 86_400_000;
const range = { from: NOW - DAY, to: NOW, intervalMs: 240_000, grouping: 'auto' };
const logger = { error() {} };
const fixtures = { hashpower: { scrypt: 8.4e12, groestl: 3.1e10, lyra2re: 6.2e10, x17: 1.8e12, blake2s: 2.1e14 }, difficulty: { scrypt: 284000, groestl: 1200, lyra2re: 2100, x17: 58000, blake: 7100000 } };
async function listen(t, app) { app.listen(0, '127.0.0.1'); await once(app, 'listening'); t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); })); return `http://127.0.0.1:${app.address().port}`; }
async function fixture(t, { fail = false, empty = false, partial = false } = {}) {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push({ url, method: req.method, authorization: req.headers.authorization });
    if (fail) return res.writeHead(401).end('private-secret must never reach the browser');
    const results = url.searchParams.get('q').split(';').map((sql, statement_id) => {
      assert.match(sql, /^SELECT /); const measurement = sql.match(/FROM "([a-z0-9_]+)"/)[1], values = fixtures[measurement]; assert.ok(values, 'Only algorithm measurements');
      if (partial && measurement === 'difficulty') return { statement_id, error: 'private-secret' };
      if (empty) return { statement_id };
      const time = !sql.includes('time >=') && sql.includes('ASC') ? NOW - 5 * 365 * DAY : NOW - 60000;
      const fields = Object.keys(values);
      return { statement_id, series: [{ name: measurement, columns: ['time', ...fields, 'private_secret'], values: [[time, ...Object.values(values), 'private-secret']] }] };
    });
    res.end(JSON.stringify({ results }));
  });
  const influxUrl = await listen(t, upstream), config = loadWebConfig({ INFLUX_URL: influxUrl, INFLUX_READ_USERNAME: 'private-user', INFLUX_READ_PASSWORD: 'private-password' });
  const reader = createDataReader(createInflux(config.influx), { now: () => NOW, logger }); const app = await createWebServer({ config, reader, now: () => NOW, logger });
  return { url: await listen(t, app), reader, requests, query: new URLSearchParams({ from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() }) };
}
test('public reader needs no daemon credentials and only binds loopback', () => {
  const config = loadWebConfig({ VERGE_CREDENTIALS_FILE: '/not/a/file', INFLUX_USERNAME: 'writer', INFLUX_PASSWORD: 'write-pass', INFLUX_READ_USERNAME: 'reader', INFLUX_READ_PASSWORD: 'read-pass' });
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 3001); assert.equal(config.influx.user, 'reader');
  assert.throws(() => loadWebConfig({ WEB_HOST: '0.0.0.0' }), /loopback/); assert.throws(() => loadWebConfig({ WEB_HOST: '::' }), /loopback/); assert.throws(() => loadWebConfig({ WEB_PORT: 'invalid' }), /WEB_PORT/);
});
test('time controls validate date ranges, enforce grouping bounds, and reject SQL injection', () => {
  const valid = new URLSearchParams({ from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() }); assert.deepEqual(parseRange(valid, NOW), range);
  for (const query of ['q=DROP+DATABASE+verge', 'from=2026-11-05T00:00:00Z', 'from=2026-02-31T00:00:00Z&to=2026-11-06T00:00:00Z', 'from=2026-11-06T00:00:00Z&to=2026-11-05T00:00:00Z', 'from=1970-01-01T00:00:00Z&to=2026-11-05T00:00:00Z', valid.toString() + '&bucket=DROP', valid.toString() + '&from=2026-01-01T00:00:00Z']) assert.throws(() => parseRange(new URLSearchParams(query), NOW), { status: 400 });
  for (const [bucket, expected] of [['hour', 3600000], ['day', DAY], ['month', DAY]]) assert.equal(parseRange(new URLSearchParams(valid.toString() + '&bucket=' + bucket), NOW).intervalMs, expected);
  const long = new URLSearchParams({ from: '2020-01-01T00:00:00Z', to: new Date(NOW).toISOString(), bucket: 'hour' }); assert.throws(() => parseRange(long, NOW), /Hourly/); long.set('bucket', 'day'); assert.throws(() => parseRange(long, NOW), /Daily/); long.set('bucket', 'month'); assert.equal(parseRange(long, NOW).grouping, 'month');
});
test('calendar month averages weight recorded samples and honor month boundaries', () => {
  const definition = definitions.find((item) => item.key === 'difficulty'); const window = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 2, 1) };
  const result = { series: [{ columns: ['time', 'scrypt_sum', 'scrypt_count'], values: [[Date.UTC(2026, 0, 1), 10, 1], [Date.UTC(2026, 0, 2), 90, 3], [Date.UTC(2026, 1, 1), 40, 2], [Date.UTC(2026, 1, 28), 80, 2]] }] };
  const rows = monthlyRows(result, definition, window); assert.equal(rows.length, 2); assert.deepEqual(rows.map((row) => [row.time, row.scrypt]), [[Date.UTC(2026, 0, 1), 25], [Date.UTC(2026, 1, 1), 30]]); assert.equal(rows[0].x17, null);
});
test('monthly query casts integer hashrates before summing and requests matching sample counts', () => {
  const definition = definitions.find((item) => item.key === 'hashpower');
  const [aggregate, latest] = statementsFor(definition, { ...range, grouping: 'month', intervalMs: DAY });
  assert.match(aggregate, /SUM\("scrypt"::float\) AS "scrypt_sum",COUNT\("scrypt"\) AS "scrypt_count"/);
  assert.match(aggregate, /GROUP BY time\(86400s\).*LIMIT 7322$/);
  assert.match(latest, /ORDER BY time DESC LIMIT 1$/);
});
test('real HTTP reader queries only algorithm fields and keeps credentials server-side', async (t) => {
  const app = await fixture(t), response = await fetch(`${app.url}/api/dashboard?${app.query}`); assert.equal(response.status, 200); const data = await response.json();
  assert.deepEqual(Object.keys(data.datasets).sort(), ['difficulty', 'hashpower']); assert.equal(data.datasets.hashpower.latest.scrypt, 8.4e12); assert.equal(data.datasets.difficulty.latest.blake, 7100000);
  assert.deepEqual(data.availableRange, { from: NOW - 5 * 365 * DAY, to: NOW - 60000 }); assert.doesNotMatch(JSON.stringify(data), /private-secret|private_secret|private-password|private-user|transaction|mempool|market/);
  assert.equal(app.requests.length, 2);
  for (const request of app.requests) {
    assert.equal(request.method, 'GET'); assert.equal(request.url.searchParams.get('db'), 'verge'); assert.equal(request.url.searchParams.get('epoch'), 'ms'); assert.equal(request.authorization, 'Basic ' + Buffer.from('private-user:private-password').toString('base64'));
    assert.doesNotMatch(request.url.href, /private-user|private-password|transaction|mempool|meta/);
    for (const sql of request.url.searchParams.get('q').split(';')) { assert.match(sql, /^SELECT /); assert.match(sql, /"host" = 'verge'/); assert.match(sql, /LIMIT (1|362)$/); }
  }
});
test('API documentation is public without contacting the database and preserves route restrictions', async (t) => {
  const app = await fixture(t, { fail: true });
  for (const route of ['/api', '/api/']) {
    const response = await fetch(app.url + route), html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.match(html, /API reference/); assert.match(html, /id="api-form"/);
    assert.match(html, /\/api\/dashboard/); assert.match(html, /\/api\/health/);
    assert.match(html, /blake2s/); assert.match(html, /<code>blake<\/code>/);
    assert.doesNotMatch(html, /private-secret|private-password|private-user|credentials\.json|INFLUX_|VERGE_RPC_|127\.0\.0\.1/);
  }
  const home = await (await fetch(app.url)).text(); assert.match(home, /href="\/api"/);
  for (const route of ['/api/private', '/api/config', '/public/api.html', '/src/web/server.js', '/.env']) assert.equal((await fetch(app.url + route)).status, 404);
  assert.equal((await fetch(app.url + '/api', { method: 'POST' })).status, 405);
  assert.equal(app.requests.length, 0);
});

test('equal requests coalesce and cache, while changed groupings get different data', async (t) => {
  const app = await fixture(t); const values = await Promise.all(Array.from({ length: 8 }, () => app.reader.read(range))); assert.ok(values.every((value) => value === values[0])); assert.equal(app.requests.length, 2); await app.reader.read(range); assert.equal(app.requests.length, 2);
  const hourly = { ...range, grouping: 'hour', intervalMs: 3600000 }; await app.reader.read(hourly); assert.equal(app.requests.length, 3); assert.match(app.requests[2].url.searchParams.get('q'), /GROUP BY time\(3600s\)/);
});
test('no private files, arbitrary queries, write routes, login, or admin endpoints are exposed', async (t) => {
  const app = await fixture(t);
  for (const route of ['/credentials.json', '/.env', '/.git/config', '/src/config.js', '/src/backfill.js', '/api/backfill', '/backfill', '/influxdb.conf', '/deploy/PRIVATE-CONFIG.md', '/admin', '/login', '/%2e%2e/credentials.json', '/api/query?q=SHOW+DATABASES']) assert.equal((await fetch(app.url + route)).status, 404, route);
  assert.equal((await fetch(app.url + '/api/dashboard?q=DROP+DATABASE+verge')).status, 400); assert.equal((await fetch(app.url + '/api/dashboard', { method: 'POST', body: 'query=DROP DATABASE verge' })).status, 405); assert.equal(app.requests.length, 0);
});
test('bundled UI has security headers, no external scripts, and no extra market/transaction panels', async (t) => {
  const app = await fixture(t);
  for (const route of ['/', '/app.js', '/charts.js', '/styles.css', '/retrowave.css', '/mining.css', '/favicon.svg', '/api', '/api.js', '/api.css']) {
    const response = await fetch(app.url + route); assert.equal(response.status, 200, route); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(response.headers.get('access-control-allow-origin'), null);
    const content = await response.text(); assert.doesNotMatch(content, /private-secret|private-password|<script[^>]+src="https?:/);
    if (route === '/' || route === '/app.js') assert.doesNotMatch(content, /transaction|mempool|market|UTXO/i);
  }
  assert.deepEqual(await (await fetch(app.url + '/api/health')).json(), { status: 'ok', mode: 'live' }); assert.equal(app.requests.length, 0);
});
test('empty ranges stay empty; partial results work and failures reveal no upstream details', async (t) => {
  const empty = await fixture(t, { empty: true }), emptyData = await (await fetch(`${empty.url}/api/dashboard?${empty.query}`)).json(); assert.equal(emptyData.mode, 'live'); assert.equal(emptyData.latestObservedAt, null); assert.equal(emptyData.availableRange, null); assert.ok(Object.values(emptyData.datasets).every((item) => item.latest === null && item.points.length === 0));
  const partial = await fixture(t, { partial: true }), partialData = await (await fetch(`${partial.url}/api/dashboard?${partial.query}`)).json(); assert.equal(partialData.partial, true); assert.equal(partialData.datasets.hashpower.latest.scrypt, 8.4e12); assert.equal(partialData.datasets.difficulty.available, false);
  const failed = await fixture(t, { fail: true }), response = await fetch(`${failed.url}/api/dashboard?${failed.query}`); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Statistics are temporarily unavailable. Please try again shortly.' });
});
test('rate limits and query concurrency are bounded', async (t) => {
  const app = await createWebServer({ reader: { async read() { return { mode: 'live' }; } }, now: () => NOW, logger }), url = await listen(t, app);
  for (let index = 0; index < 12; index++) assert.equal((await fetch(url + '/api/dashboard')).status, 200); assert.equal((await fetch(url + '/api/dashboard')).status, 429); assert.equal((await fetch(url + '/api/health')).status, 200);
  const resolvers = [], reader = createDataReader({ query() { return new Promise((resolve) => resolvers.push(resolve)); } }, { now: () => NOW, logger });
  const pending = Promise.allSettled(Array.from({ length: 4 }, (_, index) => reader.read({ ...range, from: range.from + index * 1000 }))); await assert.rejects(reader.read({ ...range, from: range.from + 5000 }), { status: 429 }); assert.equal(resolvers.length, 4); resolvers.forEach((resolve) => resolve([])); assert.ok((await pending).every((value) => value.status === 'rejected'));
});
test('preview explicitly marks generated algorithm data and has no other dataset', async (t) => {
  const app = await createWebServer({ demo: true, now: () => NOW, logger }), url = await listen(t, app), data = await (await fetch(url + '/api/dashboard')).json(); assert.equal(data.mode, 'demo'); assert.deepEqual(Object.keys(data.datasets).sort(), ['difficulty', 'hashpower']); assert.deepEqual(await (await fetch(url + '/api/health')).json(), { status: 'ok', mode: 'demo' });
});
