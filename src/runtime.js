'use strict';

const { loadConfig } = require('./config');
const { createRpc } = require('./rpc');
const { createInflux } = require('./influx');
const { startJob } = require('./scheduler');
const { collectGeneral } = require('./general');

async function main(names, args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node src/index.js [--check | --once]\n--check: read-only Verge RPC and InfluxDB database check\n--once: collect and write one sample, then exit');
    return;
  }
  if (args.some((arg) => !['--check', '--once'].includes(arg)) || (args.includes('--check') && args.includes('--once'))) {
    throw new Error('Use --check, --once, or no arguments; see --help');
  }
  const config = loadConfig();
  const rpc = createRpc(config.rpc);
  const influx = createInflux(config.influx);
  const context = { config, rpc, influx };
  const collectors = { general: collectGeneral };
  if (args.includes('--check')) {
    const required = ['verge'];
    const checks = [{
      label: `InfluxDB (${config.influx.url.origin})`,
      async run() {
        const databases = await influx.databases();
        const missing = required.filter((name) => !databases.includes(name));
        if (missing.length) throw new Error(`InfluxDB databases missing: ${missing.join(', ')}. Restore the existing databases before starting collectors.`);
        return `databases: ${required.join(', ')}`;
      },
    }];
    checks.push({
      label: `Verge RPC (${config.rpc.url.origin})`,
      async run() { await Promise.all([rpc.send('getinfo'), rpc.send('getallnetworkhashps')]); return 'algorithm RPCs responded'; },
    });
    const results = await Promise.allSettled(checks.map((check) => check.run()));
    results.forEach((result, index) => {
      const label = checks[index].label;
      if (result.status === 'fulfilled') console.log(`[${label}] OK; ${result.value}`);
      else console.error(`[${label}] ${result.reason.message}`);
    });
    if (results.some((result) => result.status === 'rejected')) throw new Error('Connection check failed. No data written.');
    console.log(`Connection checks passed. InfluxDB databases: ${required.join(', ')}. No data written.`);
    return;
  }
  if (args.includes('--once')) {
    const results = await Promise.allSettled(names.map(async (name) => {
      await collectors[name](context);
      console.log(`[${name}] Wrote points to database.`);
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`[${names[index]}] ${result.reason.message}`);
        process.exitCode = 1;
      }
    });
    return;
  }
  const jobs = names.map((name) => startJob(name, () => collectors[name](context), config.intervalMs));
  console.log(`Collectors running: ${names.join(', ')}. Poll interval: ${config.intervalMs}ms.`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Stopping collectors; waiting for current requests.');
    await Promise.all(jobs.map((job) => job.stop()));
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function runCli(names) {
  main(names).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { main, runCli };
