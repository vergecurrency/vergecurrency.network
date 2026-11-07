'use strict';

const { loadInfluxConfig } = require('../config');

function loadWebConfig(env = process.env) {
  const host = env.WEB_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('WEB_HOST must be a loopback address; use Nginx for public access');
  const port = Number(env.WEB_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEB_PORT must be between 1 and 65535');
  // The public data reader never opens the daemon credentials or cookie file.
  return { host, port, influx: loadInfluxConfig(env, true) };
}

module.exports = { loadWebConfig };
