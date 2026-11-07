'use strict';

const { readFile } = require('node:fs/promises');
const { request, json, basicAuth } = require('./http');

function createRpc(config, fetchImpl = fetch) {
  let nextId = 0;
  async function call(method, params, timeoutMs) {
    let authorization = basicAuth(config.user, config.password);
    // Daemon cookie credentials change on restart. Read them for every call.
    if (config.cookieFile) {
      try {
        const cookie = (await readFile(config.cookieFile, 'utf8')).trim();
        if (!/^[^:]+:.+$/.test(cookie)) throw new Error('Invalid cookie');
        authorization = `Basic ${Buffer.from(cookie).toString('base64')}`;
      } catch { throw new Error('Cannot read valid Verge RPC cookie credentials'); }
    }
    const id = ++nextId;
    const response = await request(config.url, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id, method, params }),
    }, timeoutMs, fetchImpl);
    if ([401, 403].includes(response.status)) {
      await response.arrayBuffer();
      throw new Error(`Verge RPC authentication failed (HTTP ${response.status})`);
    }
    const body = await json(response, 'Verge RPC');
    // verged returns JSON-RPC errors with HTTP 500, so inspect the body first.
    if (body?.error) {
      const error = new Error(`Verge RPC ${method}: ${body.error.message ?? 'request failed'}`);
      error.code = body.error.code;
      throw error;
    }
    if (!response.ok) throw new Error(`Verge RPC ${method} failed (HTTP ${response.status})`);
    if (body?.id !== id || !Object.hasOwn(body, 'result')) throw new Error(`Verge RPC ${method} returned an invalid response`);
    return body.result;
  }
  return {
    send: (method, ...params) => call(method, params, config.timeoutMs),
  };
}

module.exports = { createRpc };
