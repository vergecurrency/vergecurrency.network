'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createRpc } = require('../src/rpc');
const { createInflux, encodePoint } = require('../src/influx');
const { collectGeneral } = require('../src/general');
const { startJob } = require('../src/scheduler');
const exec = promisify(execFile);

function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verge-mining-test-'));
  t.after(() => { for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name)); fs.rmdirSync(dir); });
  return (name, content) => { const file = path.join(dir, name); fs.writeFileSync(file, content); return file; };
}
async function server(t, handler) {
  const app = http.createServer(async (req, res) => {
    try { let body = ''; for await (const chunk of req) body += chunk; await handler(req, res, body); }
    catch (error) { res.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  return `http://127.0.0.1:${app.address().port}`;
}
async function fixture(t, { rpcError, writeStatus = 204, databases = ['verge'] } = {}) {
  const calls = [], writes = [];
  const url = await server(t, (req, res, body) => {
    const target = new URL(req.url, 'http://localhost');
    if (target.pathname === '/rpc') {
      assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('test-user:test:password').toString('base64'));
      const call = JSON.parse(body); calls.push(call); assert.equal(call.jsonrpc, '1.0');
      if (rpcError) return res.writeHead(500).end(JSON.stringify({ id: call.id, result: null, error: rpcError }));
      const result = call.method === 'getinfo' ? { difficulty_x17: 1.25, difficulty_scrypt: 2.5, difficulty_groestl: 3.75, difficulty_lyra2re: 4, difficulty_blake: 5.5, balance: 999999, private_wallet_data: 'never-store' } : call.method === 'getallnetworkhashps' ? { scrypt: 11.9, groestl: 22.5, lyra2re: 33.2, x17: 44.8, blake2s: 55.3 } : null;
      assert.ok(result, 'Only algorithm RPC calls are permitted');
      return res.end(JSON.stringify({ id: call.id, result, error: null }));
    }
    if (target.pathname === '/write') { writes.push({ database: target.searchParams.get('db'), body }); return res.writeHead(writeStatus).end(writeStatus === 204 ? undefined : 'field type conflict'); }
    if (target.pathname === '/query') return res.end(JSON.stringify({ results: [{ series: [{ columns: ['name'], values: databases.map((name) => [name]) }] }] }));
    res.writeHead(404).end();
  });
  const env = { VERGE_CREDENTIALS_FILE: files(t)('credentials.json', '{"user":"test-user","pass":"test:password"}'), VERGE_RPC_URL: url + '/rpc', INFLUX_URL: url, RPC_TIMEOUT_MS: '1500' };
  const config = loadConfig(env);
  return { context: { config, rpc: createRpc(config.rpc), influx: createInflux(config.influx) }, env, calls, writes };
}
async function cli(env, args) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VERGE_|INFLUX_|RPC_TIMEOUT_MS|COLLECT_INTERVAL_MS)/.test(name)));
  return exec(process.execPath, ['src/index.js', ...args], { cwd: path.join(__dirname, '..'), env: { ...clean, ...env }, timeout: 10_000 });
}
test('legacy credentials, environment precedence, and private cookie authentication work', (t) => {
  const file = files(t), env = { VERGE_CREDENTIALS_FILE: file('credentials.json', '{"user":"old","pass":"old","host":"localhost","port":20102}') };
  assert.equal(loadConfig(env).rpc.url.href, 'http://localhost:20102/');
  assert.equal(loadConfig({ ...env, VERGE_RPC_USER: 'new', VERGE_RPC_PASSWORD: 'new' }).rpc.user, 'new');
  const cookie = loadConfig({ ...env, VERGE_RPC_COOKIE_FILE: file('.cookie', '__cookie__:first:second\n') });
  assert.equal(cookie.rpc.password, 'first:second');
  assert.throws(() => loadConfig({ ...env, COLLECT_INTERVAL_MS: '0' }), /COLLECT_INTERVAL_MS/);
  assert.throws(() => loadConfig({ ...env, VERGE_RPC_URL: 'http://secret:password@localhost' }), /set credentials separately/);
  assert.throws(() => loadConfig({ ...env, VERGE_CREDENTIALS_FILE: file('bad.json', '{"pass":"secret"') }), (error) => !error.message.includes('secret'));
});
test('collector calls only algorithm RPCs and writes only the original difficulty/hashpower series', async (t) => {
  const app = await fixture(t); await collectGeneral(app.context);
  assert.deepEqual(app.calls.map((call) => call.method).sort(), ['getallnetworkhashps', 'getinfo']);
  assert.deepEqual(app.writes, [{ database: 'verge', body: 'difficulty,host=verge blake=5.5,groestl=3.75,lyra2re=4,scrypt=2.5,x17=1.25\nhashpower,host=verge blake2s=55i,groestl=22i,lyra2re=33i,scrypt=11i,x17=44i' }]);
  assert.doesNotMatch(app.writes[0].body, /balance|wallet|transaction|mempool|market/);
});
test('line protocol skips missing numbers, preserves integer types, and rejects corrupt fields', () => {
  const point = (fields, host = 'verge') => ({ measurement: 'hashpower', tags: { host }, fields });
  assert.equal(encodePoint('verge', point({ scrypt: 11.9, x17: null }, 'a,b c=d')), 'hashpower,host=a\\,b\\ c\\=d scrypt=11i');
  for (const value of [NaN, Infinity, '10', false]) assert.throws(() => encodePoint('verge', point({ scrypt: value })), /finite number/);
  assert.throws(() => encodePoint('verge', point({ scrypt: 1e25 })), /outside InfluxDB range/);
  assert.throws(() => encodePoint('verge', point({ scrypt: null })), /No numeric fields/);
});
test('RPC preserves JSON error codes and reports HTTP authentication errors without secrets', async (t) => {
  const failed = await fixture(t, { rpcError: { code: -32601, message: 'Method not found' } });
  await assert.rejects(failed.context.rpc.send('getinfo'), { code: -32601, message: 'Verge RPC getinfo: Method not found' });
  const url = await server(t, (_req, res) => res.writeHead(401).end('unauthorized'));
  await assert.rejects(createRpc({ url, user: 'secret', password: 'secret', timeoutMs: 1000 }).send('getinfo'), (error) => /authentication failed/.test(error.message) && !error.message.includes('secret'));
});
test('RPC re-reads rotated daemon cookies and bounds timeouts', async (t) => {
  const file = files(t)('.cookie', '__cookie__:one'), auth = [];
  const url = await server(t, (req, res, body) => { auth.push(req.headers.authorization); res.end(JSON.stringify({ id: JSON.parse(body).id, result: 1, error: null })); });
  const rpc = createRpc({ url, cookieFile: file, timeoutMs: 1000 });
  await rpc.send('getinfo'); fs.writeFileSync(file, '__cookie__:two'); await rpc.send('getinfo');
  assert.deepEqual(auth, ['__cookie__:one', '__cookie__:two'].map((value) => 'Basic ' + Buffer.from(value).toString('base64')));
  const stalled = await server(t, () => {}); await assert.rejects(createRpc({ url: stalled, timeoutMs: 30 }).send('getinfo'), /timed out/);
});
test('scheduler prevents overlapping runs and drains the current request on shutdown', async () => {
  const timers = [], messages = []; let complete, calls = 0;
  const job = startJob('algorithms', () => { calls++; return new Promise((resolve) => { complete = resolve; }); }, 60_000, { now: () => 125_000, setTimer: (callback, delay) => { const value = { callback, delay }; timers.push(value); return value; }, clearTimer: (value) => { if (value) value.cancelled = true; }, logger: { log: (message) => messages.push(message), error: assert.fail } });
  assert.equal(calls, 1); assert.equal(timers.length, 0); complete(); await Promise.resolve(); assert.equal(timers[0].delay, 55_000);
  timers[0].callback(); let stopped = false; const stop = job.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false); complete(); await stop;
  assert.equal(calls, 2); assert.equal(timers.length, 1); assert.equal(timers[0].cancelled, true); assert.equal(messages.length, 2);
});
test('scheduler retries failures without falsely reporting successful collection', async () => {
  const logs = [], errors = [], timers = [];
  const job = startJob('algorithms', async () => { throw new Error('database unavailable'); }, 60_000, { setTimer: (callback) => timers.push(callback), clearTimer() {}, logger: { log: (message) => logs.push(message), error: (message) => errors.push(message) } });
  await Promise.resolve(); assert.equal(timers.length, 1); assert.deepEqual(logs, []); assert.deepEqual(errors, ['[algorithms] database unavailable']); await job.stop();
});
test('CLI check is read-only, requires only verge, and identifies each refused service', async (t) => {
  const app = await fixture(t); const result = await cli(app.env, ['--check']); assert.match(result.stdout, /Connection checks passed/); assert.equal(app.writes.length, 0);
  const missing = await fixture(t, { databases: [] }); await assert.rejects(cli(missing.env, ['--check']), (error) => error.code === 1 && /databases missing: verge/.test(error.stderr));
  const closed = http.createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening'); const url = `http://127.0.0.1:${closed.address().port}`; await new Promise((resolve) => closed.close(resolve));
  for (const [setting, label] of [['VERGE_RPC_URL', 'Verge RPC'], ['INFLUX_URL', 'InfluxDB']]) await assert.rejects(cli({ ...app.env, [setting]: url }, ['--check']), (error) => error.code === 1 && error.stderr.includes(`[${label} (${url})] HTTP request ECONNREFUSED`) && error.stdout.includes('OK;'));
});
test('CLI once writes algorithm data and returns nonzero on failed writes', async (t) => {
  const app = await fixture(t); await cli(app.env, ['--once']); assert.equal(app.writes.length, 1); assert.equal(app.writes[0].body.split('\n').length, 2);
  const failed = await fixture(t, { writeStatus: 400 }); await assert.rejects(cli(failed.env, ['--once']), (error) => error.code === 1 && /field type conflict/.test(error.stderr) && !/Wrote points/.test(error.stdout));
});
