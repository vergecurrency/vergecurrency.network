'use strict';

const { readFileSync } = require('node:fs');
const path = require('node:path');

function httpUrl(value, name) {
  let url;
  try { url = new URL(value); } catch {
    throw new Error(`${name} must be an absolute HTTP or HTTPS URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must use HTTP(S); set credentials separately`);
  }
  if (url.search || url.hash) throw new Error(`${name} cannot contain a query or fragment`);
  return url;
}

function integer(env, name, fallback, minimum = 1, maximum = 2_147_483_647) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function loadInfluxConfig(env = process.env, readOnly = false) {
  return {
    url: httpUrl(env.INFLUX_URL ?? 'http://127.0.0.1:8086', 'INFLUX_URL'),
    user: (readOnly ? env.INFLUX_READ_USERNAME : undefined) ?? env.INFLUX_USERNAME ?? '',
    password: (readOnly ? env.INFLUX_READ_PASSWORD : undefined) ?? env.INFLUX_PASSWORD ?? '',
    timeoutMs: integer(env, 'INFLUX_TIMEOUT_MS', 15_000),
  };
}

function loadConfig(env = process.env) {
  const credentialsPath = env.VERGE_CREDENTIALS_FILE || path.join(__dirname, '..', 'credentials.json');
  let credentials = {};
  try {
    credentials = JSON.parse(readFileSync(credentialsPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Expected a JSON object');
  } catch (error) {
    if (error.code !== 'ENOENT' || env.VERGE_CREDENTIALS_FILE) throw new Error('Cannot read valid JSON from the Verge credentials file');
  }
  let user = env.VERGE_RPC_USER ?? credentials.user;
  let password = env.VERGE_RPC_PASSWORD ?? credentials.pass;
  if (env.VERGE_RPC_COOKIE_FILE) {
    let cookie;
    try { cookie = readFileSync(env.VERGE_RPC_COOKIE_FILE, 'utf8').trim(); } catch {
      throw new Error('Cannot read VERGE_RPC_COOKIE_FILE');
    }
    const separator = cookie.indexOf(':');
    if (separator < 1 || separator === cookie.length - 1) throw new Error('VERGE_RPC_COOKIE_FILE must contain username:password');
    user = cookie.slice(0, separator);
    password = cookie.slice(separator + 1);
  }
  if (typeof user !== 'string' || !user || typeof password !== 'string' || !password) {
    throw new Error('Set Verge RPC user/password in credentials.json or VERGE_RPC_USER/VERGE_RPC_PASSWORD');
  }
  const host = credentials.host ?? '127.0.0.1';
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const defaultRpcUrl = `${credentials.ssl ? 'https' : 'http'}://${hostname}:${credentials.port ?? 20102}`;
  return {
    rpc: {
      url: httpUrl(env.VERGE_RPC_URL ?? defaultRpcUrl, 'VERGE_RPC_URL'), user, password,
      cookieFile: env.VERGE_RPC_COOKIE_FILE,
      timeoutMs: integer(env, 'RPC_TIMEOUT_MS', 15_000),
    },
    influx: loadInfluxConfig(env),
    intervalMs: integer(env, 'COLLECT_INTERVAL_MS', 60_000, 1_000),
  };
}

module.exports = { loadConfig, loadInfluxConfig };
