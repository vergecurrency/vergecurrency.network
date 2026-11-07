'use strict';

const http = require('node:http');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { isIP } = require('node:net');
const { createInflux } = require('../influx');
const { loadWebConfig } = require('./config');
const { createDataReader, parseRange, PublicError } = require('./data');
const { demoData } = require('./demo');

const publicDirectory = path.join(__dirname, '..', '..', 'public');
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/api': ['api.html', 'text/html; charset=utf-8'],
  '/api/': ['api.html', 'text/html; charset=utf-8'],
  '/api.js': ['api.js', 'text/javascript; charset=utf-8'],
  '/api.css': ['api.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/retrowave.css': ['retrowave.css', 'text/css; charset=utf-8'],
  '/mining.css': ['mining.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

async function createWebServer({ config = loadWebConfig(), reader, demo = false, logger = console, now = Date.now } = {}) {
  reader ??= createDataReader(createInflux(config.influx), { logger, now });
  const bundled = new Map(await Promise.all(Object.entries(assets).map(async ([url, [filename, type]]) => [url, { type, content: await readFile(path.join(publicDirectory, filename)) }])));
  const visitors = new Map();
  function allowed(req) {
    const forwarded = req.headers['x-real-ip'];
    const key = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
    const stamp = now();
    const record = visitors.get(key);
    if (!record || stamp - record.start >= 10_000) {
      visitors.delete(key);
      visitors.set(key, { start: stamp, count: 1 });
      if (visitors.size > 2048) visitors.delete(visitors.keys().next().value);
      return true;
    }
    return ++record.count <= 12;
  }

  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 15_000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    function json(status, value) {
      if (res.destroyed) return;
      const body = Buffer.from(JSON.stringify(value));
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    }
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(405, { error: 'This dashboard is read-only.' });
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048) throw new PublicError(400, 'Invalid request.');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') return json(200, { status: 'ok', mode: demo ? 'demo' : 'live' });
      if (url.pathname === '/api/dashboard') {
        if (!allowed(req)) {
          res.setHeader('Retry-After', '10');
          throw new PublicError(429, 'Too many refreshes. Please wait a few seconds.');
        }
        const range = parseRange(url.searchParams, now());
        const payload = demo ? demoData(range, now()) : await reader.read(range);
        return json(200, payload);
      }
      const asset = bundled.get(url.pathname);
      if (!asset) return json(404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.content.length, 'Cache-Control': asset.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300' });
      res.end(req.method === 'HEAD' ? undefined : asset.content);
    } catch (error) {
      if (!(error instanceof PublicError)) logger.error(`[public dashboard] ${error.message}`);
      json(error instanceof PublicError ? error.status : 503, { error: error instanceof PublicError ? error.message : 'Statistics are temporarily unavailable. Please try again shortly.' });
    }
  });
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 200;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--demo')) throw new Error('Usage: node src/web/server.js [--demo]');
  const config = loadWebConfig();
  const demo = args.includes('--demo');
  const server = await createWebServer({ config, demo });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  console.log(`Verge public dashboard: http://${host}:${config.port}${demo ? ' (DEMO: generated sample data)' : ''}`);
  const stop = () => {
    server.close();
    server.closeIdleConnections();
    const force = setTimeout(() => { server.closeAllConnections(); }, 20_000);
    force.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { createWebServer, main };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
