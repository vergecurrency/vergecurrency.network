const $ = (id) => document.getElementById(id);
const durations = { '1h': 3600000, '1d': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
const fields = $('api-fields'), form = $('api-form'), period = $('api-period');
const from = $('api-from'), to = $('api-to'), bucket = $('api-bucket');
const error = $('api-error'), curl = $('api-curl'), open = $('api-open'), status = $('api-status');
const run = $('api-run'), result = $('api-result');
let copyTimer;

function selectedUrl() {
  // Relative presets stay relative when a visitor runs or copies a request later.
  if (durations[period.value]) {
    const end = Math.floor(Date.now() / 60000) * 60000;
    from.value = new Date(end - durations[period.value]).toISOString().slice(0, 16);
    to.value = new Date(end).toISOString().slice(0, 16);
  }
  const start = Date.parse(from.value + 'Z'), end = Date.parse(to.value + 'Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Choose a valid UTC start before the end.');
  if (end > Date.now() + 300000 || end - start > 20 * 366 * 86400000) throw new Error('Choose a past date range of up to 20 years.');
  if (bucket.value === 'hour' && end - start > 31 * 86400000) throw new Error('Hourly grouping supports up to 31 days. Choose Day or Calendar month.');
  if (bucket.value === 'day' && end - start > 744 * 86400000) throw new Error('Daily grouping supports up to 744 days. Choose Calendar month.');
  const url = new URL('/api/dashboard', location.origin);
  url.search = new URLSearchParams({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), bucket: bucket.value });
  return url;
}

function updateExample() {
  try {
    const url = selectedUrl();
    curl.textContent = `curl -fsS '${url.href}'`;
    open.href = url.href; open.removeAttribute('aria-disabled');
    error.hidden = true;
    return url;
  } catch (failure) {
    error.textContent = failure.message; error.hidden = false;
    curl.textContent = 'Choose valid dates and grouping to build your request.';
    open.removeAttribute('href'); open.setAttribute('aria-disabled', 'true');
    return null;
  }
}

period.addEventListener('change', updateExample);
bucket.addEventListener('change', updateExample);
for (const input of [from, to]) input.addEventListener('input', () => { period.value = 'custom'; updateExample(); });
fields.disabled = false;
$('api-quick-curl').textContent = `curl -fsS '${new URL('/api/dashboard', location.origin).href}'`;
updateExample();

$('api-copy').addEventListener('click', async () => {
  if (!updateExample()) return;
  clearTimeout(copyTimer);
  try { await navigator.clipboard.writeText(curl.textContent); $('api-copy-status').textContent = 'Copied'; }
  catch { $('api-copy-status').textContent = 'Select and copy the command below.'; }
  copyTimer = setTimeout(() => { $('api-copy-status').textContent = ''; }, 4000);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = updateExample();
  if (!url || run.disabled) return;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  run.disabled = true; form.setAttribute('aria-busy', 'true');
  error.hidden = true; status.textContent = 'Requesting chart data…'; result.hidden = true;
  const start = performance.now();
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const data = await response.json();
    result.textContent = JSON.stringify(data, null, 2); result.hidden = false;
    status.textContent = `HTTP ${response.status} · ${Math.round(performance.now() - start)} ms`;
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      throw new Error(`${data.error ?? 'Request failed.'}${retry ? ` Retry after ${retry} seconds.` : ''}`);
    }
    const counts = ['hashpower', 'difficulty'].map((metric) => `${data.datasets?.[metric]?.points?.length ?? 0} ${metric === 'hashpower' ? 'hashrate' : 'difficulty'} points`);
    status.textContent += ` · ${counts.join(' / ')}`;
  } catch (failure) {
    error.textContent = failure.name === 'AbortError' ? 'The request timed out after 20 seconds. Try again later.' : failure.message;
    error.hidden = false;
    if (result.hidden) status.textContent = 'Request could not be completed.';
  } finally {
    clearTimeout(timeout); run.disabled = false; form.removeAttribute('aria-busy');
  }
});
