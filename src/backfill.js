'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { loadConfig } = require('./config');
const { createRpc } = require('./rpc');
const { createInflux, encodePoint } = require('./influx');
const { schemas } = require('./schema');

const MINUTE = 60_000, DAY = 1440 * MINUTE;
const CONFIRMATIONS = 6, LIVE_MARGIN = 10 * MINUTE, MAX_BUCKETS = 100_000;
const MEASUREMENTS = ['difficulty', 'hashpower'];
const HELP = `Usage: npm run backfill -- [options]
  --days N                 Last N days (default 21; maximum 366)
  --from ISO --to ISO       Optional explicit UTC dates, e.g. 2026-10-16T00:00:00Z
  --interval-minutes N     Snapshot spacing (default 5; 1 to 1440)
  --rpc-delay-ms N         Pause between daemon requests (default 50)
  --dry-run                Preview only (the default)
  --write                  Fill missing intervals in InfluxDB
  --help                   Show this help without opening credentials

Only complete UTC intervals are used. The newest ten minutes and the six newest
blocks are excluded. Each measurement is skipped in any interval with existing
algorithm data. Rerun the same dates to resume; do not run two backfills together.
Snapshots use chain median time, not the original collector's observation time.
No transaction index, daemon reindex, or public endpoint is needed.`;

function parseOptions(args, now = Date.now()) {
  const values = new Map();
  const switches = new Set(['--write', '--dry-run', '--help']);
  const parameters = new Set(['--days', '--from', '--to', '--interval-minutes', '--rpc-delay-ms']);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if ((!switches.has(name) && !parameters.has(name)) || values.has(name)) throw new Error(`Unknown or repeated option: ${name}; use --help`);
    if (switches.has(name)) values.set(name, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
      values.set(name, value);
    }
  }
  if (values.has('--help')) return { help: true };
  if (values.has('--write') && values.has('--dry-run')) throw new Error('Choose --write or --dry-run');
  if (values.has('--days') && values.has('--from')) throw new Error('Choose --days or --from');
  function integer(name, fallback, minimum, maximum) {
    const raw = values.get(name) ?? String(fallback), value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    return value;
  }
  function date(name, fallback) {
    if (!values.has(name)) return fallback;
    const raw = values.get(name), value = Date.parse(raw);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw) || !Number.isFinite(value) || new Date(value).toISOString().slice(0, 19) !== raw.slice(0, 19)) {
      throw new Error(`${name} must be a valid ISO UTC date ending in Z`);
    }
    return value;
  }
  const intervalMs = integer('--interval-minutes', 5, 1, 1440) * MINUTE;
  const to = date('--to', now);
  const from = date('--from', to - integer('--days', 21, 1, 366) * DAY);
  if (from < 0 || to <= from || to > now || to - from > 366 * DAY) throw new Error('Choose an ordered past date range of up to 366 days');
  if (Math.ceil((to - from) / intervalMs) > MAX_BUCKETS) throw new Error(`Range exceeds ${MAX_BUCKETS} intervals; increase --interval-minutes`);
  return { from, to, intervalMs, rpcDelayMs: integer('--rpc-delay-ms', 50, 0, 10_000), write: values.has('--write') };
}

// Match CBlockHeader::GetAlgo in Verge's src/primitives/block.h. The enum's
// numeric IDs are different from these version bits. No block bodies are read.
function algorithm(header) {
  if (header.proof && header.proof !== 'pow') throw new Error('This range contains non-PoW blocks; choose a range of mining history');
  const key = { 0: 'scrypt', 0x0800: 'scrypt', 0x1000: 'groestl', 0x1800: 'x17', 0x2000: 'blake', 0x5000: 'lyra2re' }[header.version & 0x7800];
  if (!key || !(header.difficulty > 0)) throw new Error(`Unsupported mining header at height ${header.height}`);
  return key;
}

function presenceQueries(from, to, intervalMs) {
  const where = `"host" = 'verge' AND time >= '${new Date(from).toISOString()}' AND time < '${new Date(to).toISOString()}'`;
  return MEASUREMENTS.map((name) => `SELECT ${Object.keys(schemas.verge[name]).map((field) => `COUNT("${field}") AS "${field}"`).join(',')} FROM "${name}" WHERE ${where} GROUP BY time(${intervalMs}ms) fill(none) LIMIT ${Math.ceil((to - from) / intervalMs) + 1}`);
}

function readPresence(results, from, to, intervalMs) {
  if (!Array.isArray(results) || results.length !== MEASUREMENTS.length) throw new Error('Incomplete InfluxDB history check; no intervals may be safely filled');
  return Object.fromEntries(MEASUREMENTS.map((name, index) => {
    const part = results[index], present = new Set();
    if (!part || part.error || part.partial) throw new Error(`InfluxDB history check failed for ${name}`);
    for (const series of part.series ?? []) {
      if (series.partial || !Array.isArray(series.columns) || !Array.isArray(series.values)) throw new Error('Incomplete InfluxDB history response');
      const timeIndex = series.columns.indexOf('time');
      const fields = Object.keys(schemas.verge[name]).map((field) => series.columns.indexOf(field));
      if (timeIndex < 0 || fields.some((column) => column < 0)) throw new Error('Invalid InfluxDB history columns');
      for (const row of series.values) {
        const time = row[timeIndex];
        if (!Number.isSafeInteger(time) || time < from || time >= to || time % intervalMs) throw new Error('Invalid InfluxDB interval timestamp');
        const counts = fields.map((column) => row[column]);
        if (counts.some((count) => count !== null && (!Number.isSafeInteger(count) || count < 0))) throw new Error('Invalid InfluxDB sample counts');
        if (counts.some((count) => count > 0)) present.add(time);
      }
    }
    return [name, present];
  }));
}

async function runBackfill(options, { rpc, influx, logger = console, now = Date.now, signal, pause = (ms) => delay(ms, undefined, { signal }) }) {
  const stats = { written: { difficulty: 0, hashpower: 0 }, planned: {}, skipped: {}, rpcCalls: 0, headers: 0, writeAttempted: false };
  function checkStop() { signal?.throwIfAborted(); }
  let lastProgress = now();
  function progress(force = false) {
    if (force || now() - lastProgress >= 30_000) {
      logger.log(`[backfill] ${stats.headers} headers read; ${stats.rpcCalls} RPC calls; committed ${stats.written.difficulty} difficulty / ${stats.written.hashpower} hashrate points.`);
      lastProgress = now();
    }
  }
  async function call(method, ...params) {
    checkStop();
    if (stats.rpcCalls && options.rpcDelayMs) await pause(options.rpcDelayMs);
    checkStop(); stats.rpcCalls++;
    let value;
    try { value = await rpc.send(method, ...params); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      const prefix = `Verge RPC ${method}:`;
      const failure = new Error(error.message.startsWith(prefix) ? error.message : `${prefix} ${error.message}`, { cause: error });
      failure.code = error.code;
      throw failure;
    }
    checkStop(); progress();
    return value;
  }
  const hashPattern = /^[0-9a-f]{64}$/i, cache = new Map();
  async function readHeader(hash, height) {
    if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new Error('Daemon returned an invalid block hash');
    let header = cache.get(hash);
    if (!header) {
      header = await call('getblockheader', hash, true); stats.headers++;
      if (!header || header.hash !== hash || !Number.isSafeInteger(header.height) || header.height < 0 || !Number.isSafeInteger(header.version) || header.version < -2_147_483_648 || header.version > 4_294_967_295 ||
          !Number.isSafeInteger(header.time) || header.time < 0 || !Number.isSafeInteger(header.mediantime) || header.mediantime < 0 ||
          typeof header.difficulty !== 'number' || !Number.isFinite(header.difficulty) || !Number.isSafeInteger(header.confirmations) || header.confirmations < 1 ||
          (header.height > 0 && !hashPattern.test(header.previousblockhash))) throw new Error('Daemon returned an invalid or noncanonical block header');
      cache.set(hash, header);
      if (cache.size > 128) cache.delete(cache.keys().next().value);
    }
    if (header.height !== height) throw new Error('Chain changed during header lookup; rerun the same range');
    return header;
  }
  const atHeight = async (height) => readHeader(await call('getblockhash', height), height);
  try {
    logger.log('[backfill] Checking daemon synchronization (getblockchaininfo)...');
    const chain = await call('getblockchaininfo');
    if (chain?.initialblockdownload !== false || !Number.isSafeInteger(chain.blocks) || chain.blocks <= CONFIRMATIONS) throw new Error('Wait until verged has finished synchronizing before backfilling');
    logger.log(`[backfill] Reading confirmed block at height ${chain.blocks - CONFIRMATIONS} (getblockhash / getblockheader)...`);
    const anchor = await atHeight(chain.blocks - CONFIRMATIONS);
    const from = Math.ceil(options.from / options.intervalMs) * options.intervalMs;
    const to = Math.floor(Math.min(options.to, now() - LIVE_MARGIN, anchor.mediantime * 1000) / options.intervalMs) * options.intervalMs;
    if (to <= from) throw new Error('No complete historical intervals remain after the live-data and confirmation margins');
    const bucketCount = (to - from) / options.intervalMs;
    if (bucketCount > MAX_BUCKETS) throw new Error('Too many intervals; increase --interval-minutes');
    logger.log(`[backfill] ${new Date(from).toISOString()} to ${new Date(to).toISOString()} (end exclusive), every ${options.intervalMs / MINUTE} minutes.`);
    logger.log(`[backfill] ${options.write ? 'WRITE' : 'DRY RUN'}; confirmed chain anchor: height ${anchor.height}. Existing algorithm intervals will be preserved.`);
    checkStop();
    logger.log('[backfill] Checking existing InfluxDB algorithm intervals...');
    let existing;
    try { existing = await influx.query('verge', presenceQueries(from, to, options.intervalMs)); }
    catch (error) { throw new Error(`InfluxDB history check: ${error.message}`, { cause: error }); }
    const present = readPresence(existing, from, to, options.intervalMs);
    const needed = [];
    for (const name of MEASUREMENTS) {
      stats.skipped[name] = present[name].size;
      stats.planned[name] = bucketCount - present[name].size;
    }
    for (let time = from; time < to; time += options.intervalMs) {
      if (MEASUREMENTS.some((name) => !present[name].has(time))) needed.push(time);
    }
    logger.log(`[backfill] Missing: ${stats.planned.difficulty} difficulty / ${stats.planned.hashpower} hashrate intervals; existing: ${stats.skipped.difficulty} / ${stats.skipped.hashpower}.`);
    if (!needed.length) { logger.log('[backfill] Nothing to fill. No data written.'); return stats; }

    // Median time is nondecreasing along a valid PoW chain; raw block timestamps
    // are not. Find a stable historical height without assuming timestamp order.
    let low = 0, high = anchor.height;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2), header = await atHeight(middle);
      if (header.mediantime * 1000 <= needed[0]) low = middle + 1;
      else high = middle - 1;
    }
    if (high < 0) throw new Error('The selected range predates this blockchain');
    let current = await atHeight(high), seed = current, next;
    const difficulties = {};
    for (let scanned = 0; Object.keys(difficulties).length < 5; scanned++) {
      const key = algorithm(seed);
      if (!Object.hasOwn(difficulties, key)) difficulties[key] = seed.difficulty;
      if (Object.keys(difficulties).length === 5) break;
      if (!seed.height || scanned >= 9999) throw new Error('Cannot find all five mining algorithms near the start; choose a later range');
      seed = await readHeader(seed.previousblockhash, seed.height - 1);
    }
    async function historicalHashrate(height) {
      const fields = await call('getallnetworkhashps', 360, height);
      if (!fields || Object.keys(schemas.verge.hashpower).some((name) => typeof fields[name] !== 'number' || !Number.isFinite(fields[name]) || fields[name] < 0)) throw new Error(`Invalid historical hashrate response at height ${height}`);
      return Object.fromEntries(Object.keys(schemas.verge.hashpower).map((name) => [name, fields[name]]));
    }
    // Probe historical RPC support before beginning any write, even when only
    // difficulty is currently missing. Never substitute today's live hashrate.
    let initialHashrate = await historicalHashrate(current.height);
    if (!options.write) {
      logger.log(`[backfill] Historical RPC verified at height ${current.height}. No data written. Add --write to fill these intervals.`);
      return stats;
    }
    let batch = [];
    async function flush() {
      if (!batch.length) return;
      checkStop();
      if (await call('getblockhash', anchor.height) !== anchor.hash) throw new Error('Chain reorganized during backfill; stopped before the next batch. Rerun the same range');
      checkStop();
      stats.writeAttempted = true;
      await influx.write('verge', batch);
      for (const point of batch) stats.written[point.measurement]++;
      batch = [];
      progress();
    }
    for (const time of needed) {
      checkStop();
      let advanced = false;
      while (current.height < anchor.height) {
        next ??= current.nextblockhash ? await readHeader(current.nextblockhash, current.height + 1) : await atHeight(current.height + 1);
        if (next.previousblockhash !== current.hash || next.mediantime < current.mediantime) throw new Error('Chain changed during forward scan; rerun the same range');
        if (next.mediantime * 1000 > time) break;
        current = next; next = undefined; advanced = true;
        difficulties[algorithm(current)] = current.difficulty;
      }
      for (const name of MEASUREMENTS) {
        if (present[name].has(time)) continue;
        const fields = name === 'difficulty' ? { ...difficulties } : initialHashrate && !advanced ? initialHashrate : await historicalHashrate(current.height);
        const point = { measurement: name, tags: { host: 'verge', source: 'backfill' }, fields, timestamp: time };
        encodePoint('verge', point); // Validate every field before handing off a batch.
        batch.push(point);
      }
      initialHashrate = undefined;
      if (batch.length >= 100) await flush();
    }
    await flush(); progress(true);
    logger.log('[backfill] Complete. Refresh the dashboard with the historical date range selected.');
    return stats;
  } catch (error) {
    error.backfillStats = stats;
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(HELP); return; }
  const config = loadConfig(), controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { return await runBackfill(options, { rpc: createRpc(config.rpc), influx: createInflux(config.influx), signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

module.exports = { parseOptions, algorithm, presenceQueries, readPresence, runBackfill, main };
if (require.main === module) main().catch((error) => {
  console.error(`[backfill] ${error.name === 'AbortError' ? 'Stopped. Completed batches remain saved.' : error.message}`);
  if (error.backfillStats?.writeAttempted) console.error('[backfill] Rerun the same dates to resume. Existing intervals are skipped; a failed write may have saved part of its batch.');
  process.exitCode = error.name === 'AbortError' ? 130 : 1;
});
