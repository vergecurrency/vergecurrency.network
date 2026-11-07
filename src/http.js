'use strict';

async function request(url, options, timeoutMs, fetchImpl = fetch) {
  try {
    return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : (error.cause?.code ?? 'connection failed');
    throw new Error(`HTTP request ${reason}`);
  }
}

async function json(response, label) {
  try { return await response.json(); } catch {
    throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`);
  }
}

function basicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

module.exports = { request, json, basicAuth };
