'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { parseOptions, algorithm, readPresence, runBackfill } = require('../src/backfill');
const { createInflux, encodePoint } = require('../src/influx');
const { schemas } = require('../src/schema');

const MINUTE = 60_000, DAY = 1440 * MINUTE;
const BASE = Date.UTC(2026, 9, 16), NOW = BASE + 6 * 60 * MINUTE;
const hash = (height) => height.toString(16).padStart(64, '0');
const fields = (name) => Object.keys(schemas.verge[name]);
function fixture({ reorg = false, ibd = false, badHashrate = false, base = BASE } = {}) {
  // Five distinct difficulties in each round, plus deliberately unordered raw
  // timestamps. Median times remain ordered as they do on a valid PoW chain.
  const versions = [0x0800, 0x1800, 0x5000, 0x2000, 0x1000];
  const chain = Array.from({ length: 181 }, (_, height) => ({
    hash: hash(height), height, version: 0x20000000 | versions[height % 5],
    time: base / 1000 + height * 60 + (height % 2 ? 180 : 0),
    mediantime: base / 1000 + height * 60, difficulty: height + 0.25,
    confirmations: 181 - height,
    ...(height ? { previousblockhash: hash(height - 1) } : {}),
    ...(height < 180 ? { nextblockhash: hash(height + 1) } : {}),
  }));
  const records = [], calls = [], queries = [], writes = [], logs = [];
  const rpc = { async send(method, ...params) {
    calls.push({ method, params });
    if (method === 'getblockchaininfo') return { blocks: 180, initialblockdownload: ibd };
    if (method === 'getblockhash') return reorg && params[0] === 174 && calls.filter((call) => call.method === method && call.params[0] === 174).length > 1 ? 'f'.repeat(64) : hash(params[0]);
    if (method === 'getblockheader') return chain[Number.parseInt(params[0], 16)];
    if (method === 'getallnetworkhashps') {
      assert.equal(params[0], 360);
      assert.ok(params[1] >= 0 && params[1] <= 174, 'A historical confirmed height is mandatory');
      return badHashrate ? { scrypt: null } : Object.fromEntries(fields('hashpower').map((name, index) => [name, params[1] * 1000 + index + 0.75]));
    }
    assert.fail(`Unexpected RPC: ${method}`);
  } };
  const influx = {
    async query(database, statements) {
      assert.equal(database, 'verge'); queries.push(statements);
      return statements.map((statement) => {
        assert.match(statement, /^SELECT COUNT\(/);
        assert.match(statement, /"host" = 'verge'/);
        assert.match(statement, /fill\(none\)/);
        assert.doesNotMatch(statement, /DELETE|DROP|INTO|transaction|wallet/);
        const name = /FROM "(\w+)"/.exec(statement)[1];
        const from = Date.parse(/time >= '([^']+)'/.exec(statement)[1]);
        const to = Date.parse(/time < '([^']+)'/.exec(statement)[1]);
        const interval = Number(/time\((\d+)ms\)/.exec(statement)[1]);
        const counts = new Map();
        for (const point of records.filter((point) => point.measurement === name && point.timestamp >= from && point.timestamp < to)) {
          const bucket = Math.floor(point.timestamp / interval) * interval;
          const row = counts.get(bucket) ?? Object.fromEntries(fields(name).map((key) => [key, 0]));
          for (const key of fields(name)) if (point.fields[key] !== undefined && point.fields[key] !== null) row[key]++;
          counts.set(bucket, row);
        }
        return counts.size ? { series: [{ columns: ['time', ...fields(name)], values: [...counts].map(([time, values]) => [time, ...fields(name).map((key) => values[key])]) }] } : {};
      });
    },
    async write(database, points) {
      assert.equal(database, 'verge');
      writes.push(structuredClone(points)); records.push(...structuredClone(points));
    },
  };
  const options = { from: base + 10 * MINUTE, to: base + 25 * MINUTE, intervalMs: 5 * MINUTE, rpcDelayMs: 0, write: true };
  const context = { rpc, influx, logger: { log: (message) => logs.push(message) }, now: () => base + 6 * 60 * MINUTE };
  return { chain, records, calls, queries, writes, logs, options, context };
}

test('backfill options default to a 21-day read-only preview and reject unsafe ranges', () => {
  const options = parseOptions([], NOW);
  assert.equal(options.to, NOW); assert.equal(options.from, NOW - 21 * DAY);
  assert.equal(options.intervalMs, 5 * MINUTE); assert.equal(options.write, false);
  assert.equal(parseOptions(['--days', '21', '--write'], NOW).write, true);
  assert.equal(parseOptions(['--rpc-delay-ms', '0'], NOW).rpcDelayMs, 0);
  assert.equal(parseOptions(['--from', '2026-10-16T00:00:00Z', '--to', '2026-10-16T01:00:00Z'], NOW).from, BASE);
  for (const args of [
    ['--days', '0'], ['--days', '367'], ['--days', '1e2'], ['--days'], ['--days', '2', '--days', '3'],
    ['--write', '--dry-run'], ['--from', '2026-10-16T00:00:00Z', '--days', '2'],
    ['--from', '2026-02-30T00:00:00Z'], ['--to', '2028-10-16T00:00:00Z'],
    ['--from', '2026-10-16'], ['--interval-minutes', '0'], ['--days', '366', '--interval-minutes', '1'],
    ['--rpc-delay-ms', '-1'], ['--database', 'other'], ['--force'],
  ]) assert.throws(() => parseOptions(args, NOW));
});

test('version-bit algorithm decoding matches Verge and refuses non-PoW or unknown headers', () => {
  for (const [version, name] of [[2, 'scrypt'], [0x0800, 'scrypt'], [0x1000, 'groestl'], [0x1800, 'x17'], [0x2000, 'blake'], [0x5000, 'lyra2re']]) {
    assert.equal(algorithm({ version: version | 0x20000000, difficulty: 2 }), name);
  }
  assert.throws(() => algorithm({ version: 0x0800, difficulty: 2, proof: 'pos' }), /non-PoW/);
  assert.throws(() => algorithm({ version: 0x3800, difficulty: 2 }), /Unsupported/);
  assert.throws(() => algorithm({ version: 0x0800, difficulty: 0 }), /Unsupported/);
});

test('timestamped backfill line protocol preserves live formatting and sends explicit millisecond precision', async (t) => {
  const point = { measurement: 'hashpower', tags: { host: 'verge', source: 'backfill' }, fields: { scrypt: 12.9 }, timestamp: BASE };
  assert.equal(encodePoint('verge', point), `hashpower,host=verge,source=backfill scrypt=12i ${BASE}`);
  for (const timestamp of [null, -1, NaN, 1.5, 9_223_372_036_855]) assert.throws(() => encodePoint('verge', { ...point, timestamp }), /timestamp/);
  assert.throws(() => encodePoint('verge', { ...point, tags: { host: 'verge', source: 'untrusted' } }), /tag/);
  const requests = [];
  const app = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: new URL(req.url, 'http://localhost'), body }); res.writeHead(204).end();
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  const influx = createInflux({ url: new URL(`http://127.0.0.1:${app.address().port}`), timeoutMs: 1000 });
  await influx.write('verge', [point]);
  await influx.write('verge', [{ ...point, tags: { host: 'verge' }, timestamp: undefined }]);
  assert.equal(requests[0].url.searchParams.get('precision'), 'ms');
  assert.equal(requests[0].body, `hashpower,host=verge,source=backfill scrypt=12i ${BASE}`);
  assert.equal(requests[1].url.searchParams.has('precision'), false);
  assert.equal(requests[1].body, 'hashpower,host=verge scrypt=12i');
});

test('backfill fills each missing measurement, preserves partial/zero live samples, and safely resumes', async () => {
  const app = fixture();
  const live = [
    { measurement: 'difficulty', tags: { host: 'verge' }, fields: { x17: 999 }, timestamp: BASE + 11 * MINUTE },
    { measurement: 'hashpower', tags: { host: 'verge' }, fields: { scrypt: 0 }, timestamp: BASE + 16 * MINUTE },
  ];
  app.records.push(...structuredClone(live));
  const stats = await runBackfill(app.options, app.context);
  assert.deepEqual(stats.written, { difficulty: 2, hashpower: 2 });
  assert.deepEqual(stats.skipped, { difficulty: 1, hashpower: 1 });
  assert.deepEqual(app.records.slice(0, 2), live);
  const points = app.writes.flat();
  assert.deepEqual(points.map((point) => [point.measurement, (point.timestamp - BASE) / MINUTE]), [['hashpower', 10], ['difficulty', 15], ['difficulty', 20], ['hashpower', 20]]);
  assert.ok(points.every((point) => point.tags.host === 'verge' && point.tags.source === 'backfill'));
  // Latest per-algorithm values as of canonical height 15, with raw timestamps
  // out of order. Blake's historical database field remains 'blake'.
  assert.deepEqual(points[1].fields, { scrypt: 15.25, groestl: 14.25, blake: 13.25, lyra2re: 12.25, x17: 11.25 });
  assert.deepEqual(points[3].fields, { scrypt: 20000.75, groestl: 20001.75, lyra2re: 20002.75, x17: 20003.75, blake2s: 20004.75 });
  const before = app.records.length, calls = app.calls.length;
  const resumed = await runBackfill(app.options, app.context);
  assert.deepEqual(resumed.written, { difficulty: 0, hashpower: 0 });
  assert.equal(app.records.length, before);
  assert.ok(!app.calls.slice(calls).some((call) => call.method === 'getallnetworkhashps'));
  assert.match(app.logs.join('\n'), /Nothing to fill/);
});

test('dry run checks historical RPC support but never writes or scans the whole range', async () => {
  const app = fixture();
  const stats = await runBackfill({ ...app.options, write: false }, app.context);
  assert.deepEqual(stats.planned, { difficulty: 3, hashpower: 3 });
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.calls.filter((call) => call.method === 'getallnetworkhashps').map((call) => call.params), [[360, 10]]);
  assert.ok(stats.headers < 25);
  assert.match(app.logs.join('\n'), /No data written/);
});

test('backfill excludes partial intervals, live-data tail, and unconfirmed tip heights', async () => {
  const app = fixture();
  await runBackfill({ ...app.options, from: BASE + 10 * MINUTE + 1, to: NOW }, app.context);
  const points = app.writes.flat();
  assert.equal(Math.min(...points.map((point) => point.timestamp)), BASE + 15 * MINUTE);
  assert.equal(Math.max(...points.map((point) => point.timestamp)), BASE + 165 * MINUTE);
  assert.ok(app.calls.filter((call) => call.method === 'getallnetworkhashps').every((call) => call.params[1] <= 174));
  const near = fixture();
  near.context.now = () => BASE + 50 * MINUTE;
  await runBackfill({ ...near.options, to: BASE + 50 * MINUTE }, near.context);
  assert.equal(Math.max(...near.writes.flat().map((point) => point.timestamp)), BASE + 35 * MINUTE);
});

test('unsafe history responses fail closed instead of treating existing data as missing', () => {
  const columns = ['time', ...fields('difficulty')];
  const result = (row, extra = {}) => [{ series: [{ columns, values: [row], ...extra }] }, {}];
  for (const response of [[], [{ error: 'denied' }, {}], result([BASE, -1, 0, 0, 0, 0]), result([BASE + 1, 1, 0, 0, 0, 0]), result([BASE, 1, 0, 0, 0, 0], { partial: true }), result([BASE, '1', 0, 0, 0, 0])]) {
    assert.throws(() => readPresence(response, BASE, BASE + 10 * MINUTE, 5 * MINUTE));
  }
});

test('unsynced daemon, invalid hashrate, or reorganization prevents a write', async () => {
  for (const [setting, pattern] of [['ibd', /synchronizing/], ['badHashrate', /historical hashrate/], ['reorg', /reorganized/]]) {
    const app = fixture({ [setting]: true });
    await assert.rejects(runBackfill(app.options, app.context), pattern);
    assert.equal(app.writes.length, 0);
  }
});

test('backfill identifies the failed RPC or database stage before writing', async () => {
  for (const method of ['getblockchaininfo', 'getblockhash', 'getblockheader', 'getallnetworkhashps']) {
    const app = fixture(), original = app.context.rpc.send;
    app.context.rpc.send = async (name, ...params) => {
      if (name === method) throw Object.assign(new Error('HTTP request timed out after 15000ms'), { code: 'ETIMEDOUT' });
      return original(name, ...params);
    };
    await assert.rejects(runBackfill(app.options, app.context), (error) => error.message === `Verge RPC ${method}: HTTP request timed out after 15000ms` && error.code === 'ETIMEDOUT');
    assert.equal(app.writes.length, 0);
    assert.match(app.logs[0], /getblockchaininfo/);
  }
  const database = fixture();
  database.context.influx.query = async () => { throw new Error('HTTP request timed out after 15000ms'); };
  await assert.rejects(runBackfill(database.options, database.context), { message: 'InfluxDB history check: HTTP request timed out after 15000ms' });
  assert.equal(database.writes.length, 0);
});

test('a failed batch can be rerun without duplicating previous successful batches', async () => {
  const app = fixture(), original = app.context.influx.write;
  let attempts = 0;
  app.context.influx.write = async (...args) => { if (++attempts === 2) throw new Error('write unavailable'); return original(...args); };
  const options = { ...app.options, intervalMs: MINUTE, to: BASE + 150 * MINUTE };
  await assert.rejects(runBackfill(options, app.context), (error) => /write unavailable/.test(error.message) && error.backfillStats.written.difficulty === 50);
  assert.equal(app.records.length, 100);
  app.context.influx.write = original;
  const stats = await runBackfill(options, app.context);
  assert.deepEqual(stats.written, { difficulty: 90, hashpower: 90 });
  assert.equal(app.records.length, 280);
  assert.equal(new Set(app.records.map((point) => `${point.measurement}:${point.timestamp}`)).size, 280);
});

test('interrupts stop before writing and preserve already committed batches', async () => {
  const app = fixture(), controller = new AbortController();
  const original = app.context.rpc.send;
  app.context.rpc.send = async (...args) => { const value = await original(...args); if (args[0] === 'getallnetworkhashps') controller.abort(); return value; };
  await assert.rejects(runBackfill(app.options, { ...app.context, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(app.writes.length, 0);
});

test('CLI help opens no credentials and malformed arguments return nonzero', async () => {
  const run = promisify(execFile), cwd = path.join(__dirname, '..');
  const env = { ...process.env, VERGE_CREDENTIALS_FILE: path.join(cwd, 'does-not-exist.json') };
  const result = await run(process.execPath, ['src/backfill.js', '--help'], { cwd, env, timeout: 10_000 });
  assert.match(result.stdout, /--write/); assert.equal(result.stderr, '');
  await assert.rejects(run(process.execPath, ['src/backfill.js', '--days', '0'], { cwd, env, timeout: 10_000 }), (error) => error.code === 1 && /--days/.test(error.stderr) && !/credentials/.test(error.stderr));
});

test('complete CLI loads private env settings and writes only timestamped algorithm history over HTTP', async (t) => {
  const base = Math.floor((Date.now() - DAY) / (60 * MINUTE)) * 60 * MINUTE;
  const app = fixture({ base }), bodies = [], auth = 'Basic ' + Buffer.from('backfill-test:private-test-password').toString('base64');
  const upstream = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const url = new URL(req.url, 'http://localhost');
      assert.equal(req.headers.authorization, auth);
      if (url.pathname === '/rpc') {
        const call = JSON.parse(body);
        return res.end(JSON.stringify({ id: call.id, result: await app.context.rpc.send(call.method, ...call.params), error: null }));
      }
      if (url.pathname === '/query') {
        assert.equal(url.searchParams.get('epoch'), 'ms');
        return res.end(JSON.stringify({ results: await app.context.influx.query(url.searchParams.get('db'), url.searchParams.get('q').split(';')) }));
      }
      assert.equal(url.pathname, '/write');
      assert.equal(url.searchParams.get('db'), 'verge');
      assert.equal(url.searchParams.get('precision'), 'ms');
      bodies.push(body); res.writeHead(204).end();
    } catch (error) { res.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verge-backfill-cli-'));
  t.after(() => { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); });
  const url = `http://127.0.0.1:${upstream.address().port}`;
  fs.writeFileSync(path.join(directory, 'credentials.json'), '{"user":"unused","pass":"unused"}');
  const envFile = path.join(directory, '.env');
  fs.writeFileSync(envFile, [
    `VERGE_RPC_URL=${url}/rpc`, `INFLUX_URL=${url}`,
    'VERGE_RPC_USER=backfill-test', 'VERGE_RPC_PASSWORD=private-test-password',
    'INFLUX_USERNAME=backfill-test', 'INFLUX_PASSWORD=private-test-password',
  ].join('\n'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VERGE_|INFLUX_|RPC_TIMEOUT_MS)/.test(name)));
  env.VERGE_CREDENTIALS_FILE = path.join(directory, 'credentials.json');
  const run = promisify(execFile), args = [`--env-file=${envFile}`, 'src/backfill.js', '--from', new Date(app.options.from).toISOString(), '--to', new Date(app.options.to).toISOString(), '--rpc-delay-ms', '0', '--write'];
  const result = await run(process.execPath, args, { cwd: path.join(__dirname, '..'), env, timeout: 10_000 });
  assert.match(result.stdout, /Complete/); assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /private-test-password|backfill-test/);
  assert.equal(bodies.length, 1);
  const lines = bodies[0].split('\n'); assert.equal(lines.length, 6);
  for (let index = 0; index < lines.length; index++) {
    assert.match(lines[index], /^(difficulty|hashpower),host=verge,source=backfill /);
    assert.equal(Number(lines[index].split(' ').at(-1)), base + (10 + Math.floor(index / 2) * 5) * MINUTE);
    assert.doesNotMatch(lines[index], /wallet|transaction|mempool|market|password/);
  }
  assert.match(lines[0], /blake=8\.25/);
  assert.match(lines[1], /scrypt=10000i/);
});
