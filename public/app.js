import { renderChart, sparkline, compact } from './charts.js';

const $ = (id) => document.getElementById(id);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const DAY = 86_400_000;
const algorithms = [
  { key: 'scrypt', name: 'Scrypt', color: '#56eeff', difficulty: 'scrypt' },
  { key: 'groestl', name: 'Groestl', color: '#ff62cf', difficulty: 'groestl' },
  { key: 'lyra2re', name: 'Lyra2RE', color: '#bd9bff', difficulty: 'lyra2re' },
  { key: 'x17', name: 'X17', color: '#67f0bf', difficulty: 'x17' },
  { key: 'blake2s', name: 'Blake2s', color: '#ffbd7a', difficulty: 'blake' },
];
const durations = { '1h': 3_600_000, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '1y': 365 * DAY };
const params = new URLSearchParams(location.search);
const state = {
  period: Object.hasOwn(durations, params.get('period')) ? params.get('period') : '24h',
  algorithm: algorithms.some((algo) => algo.key === params.get('algorithm')) ? params.get('algorithm') : 'scrypt',
  view: params.get('view') === 'difficulty' ? 'difficulty' : 'hashpower',
  grouping: ['auto', 'hour', 'day', 'month'].includes(params.get('bucket')) ? params.get('bucket') : 'auto',
  utc: params.get('zone') !== 'local', auto: true, custom: null, data: null, controller: null,
};
if (params.has('from') && params.has('to')) {
  const from = Date.parse(params.get('from')), to = Date.parse(params.get('to'));
  if (finite(from) && finite(to) && from < to) { state.custom = { from, to }; state.period = params.get('period') === 'all' ? 'all' : 'custom'; state.auto = false; }
}
const text = (id, value) => { $(id).textContent = value; };
const dataset = (key) => state.data?.datasets[key] ?? { points: [], latest: null, available: false };
const dateFormat = (options = {}) => new Intl.DateTimeFormat('en-US', { ...options, ...(state.utc ? { timeZone: 'UTC' } : {}) });
const fullDate = (value) => dateFormat({ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
const formatter = () => state.view === 'difficulty' ? (value) => compact(value) : (value) => compact(value, 'H/s');
function change(points, field) {
  const values = points.map((row) => row[field]).filter(finite);
  return values.length > 1 && values[0] !== 0 ? (values.at(-1) - values[0]) / Math.abs(values[0]) * 100 : null;
}
const changeText = (value) => finite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
function currentRange() {
  if (state.custom) return state.custom;
  const to = Math.floor(Date.now() / 60_000) * 60_000;
  if (state.period === 'all' && state.data?.availableRange) return { from: state.data.availableRange.from, to: Math.min(Date.now(), state.data.availableRange.to + 60_000) };
  if (['30d', '90d', '1y'].includes(state.period)) {
    const date = new Date(to), months = { '30d': 1, '90d': 3, '1y': 12 }[state.period];
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1));
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    return { from: Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes()), to };
  }
  return { from: to - (durations[state.period] ?? DAY), to };
}
function syncUrl() {
  const search = new URLSearchParams({ period: state.period, algorithm: state.algorithm, view: state.view, bucket: state.grouping, zone: state.utc ? 'utc' : 'local' });
  if (state.custom || state.period === 'all') { const range = currentRange(); search.set('from', new Date(range.from).toISOString()); search.set('to', new Date(range.to).toISOString()); }
  history.replaceState(null, '', `${location.pathname}?${search}${location.hash}`);
}
function syncControls() {
  const span = currentRange().to - currentRange().from;
  if (state.grouping === 'hour' && span > 31 * DAY) state.grouping = span > 744 * DAY ? 'month' : 'day';
  if (state.grouping === 'day' && span > 744 * DAY) state.grouping = 'month';
  $('grouping').value = state.grouping;
  $('grouping').querySelector('[value=hour]').disabled = span > 31 * DAY;
  $('grouping').querySelector('[value=day]').disabled = span > 744 * DAY;
  document.querySelectorAll('[data-period]').forEach((button) => { button.setAttribute('aria-pressed', String(button.dataset.period === state.period)); if (button.dataset.period === 'all') button.disabled = !state.data?.availableRange; });
  document.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
  $('auto-refresh').setAttribute('aria-pressed', String(state.auto));
  $('timezone').firstChild.textContent = state.utc ? 'UTC ' : 'Local ';
  text('date-zone', `Dates entered in ${state.utc ? 'UTC' : 'your local time zone'}`);
  text('footer-time', `Times shown in ${state.utc ? 'UTC' : 'your local time zone'} · Samples collected every minute`);
}
function selectAlgorithm(key) { state.algorithm = key; renderAlgorithms(); renderMining(); renderTable(); syncUrl(); }
function renderAlgorithms() {
  const source = dataset(state.view), container = $('algorithm-cards'); container.replaceChildren();
  algorithms.forEach((algorithm) => {
    const field = state.view === 'difficulty' ? algorithm.difficulty : algorithm.key, value = formatter()(source.latest?.[field]);
    const button = document.createElement('button'); button.type = 'button'; button.className = `algorithm-card ${algorithm.key}`; button.dataset.algorithm = algorithm.key;
    button.setAttribute('aria-pressed', String(algorithm.key === state.algorithm)); button.setAttribute('aria-label', `${algorithm.name}, ${value}. Show chart`);
    const name = document.createElement('span'); name.className = 'algorithm-name'; const dot = document.createElement('span'); dot.className = 'algorithm-dot'; name.append(dot, document.createTextNode(algorithm.name));
    const number = document.createElement('span'); number.className = 'algorithm-number'; const [amount, ...units] = value.split(' '); const unit = document.createElement('small'); unit.textContent = units.join(' '); number.append(document.createTextNode(amount), unit);
    const secondary = document.createElement('span'); secondary.className = 'algorithm-secondary'; secondary.textContent = state.view === 'hashpower' ? `Difficulty ${compact(dataset('difficulty').latest?.[algorithm.difficulty])}` : `Hashrate ${compact(dataset('hashpower').latest?.[algorithm.key], 'H/s')}`;
    const trend = document.createElement('span'); trend.className = 'algorithm-trend'; const movement = document.createElement('span'); movement.textContent = changeText(change(source.points, field)); movement.title = 'Change between the first and last chart sample';
    trend.append(movement, sparkline(source.points, field, algorithm.color)); button.append(name, number, secondary, trend); button.onclick = () => selectAlgorithm(algorithm.key); container.append(button);
  });
}
function renderMining() {
  const algorithm = algorithms.find((item) => item.key === state.algorithm), source = dataset(state.view), field = state.view === 'difficulty' ? algorithm.difficulty : algorithm.key, format = formatter();
  const values = source.points.map((row) => row[field]).filter(finite);
  text('mining-title', `${algorithm.name} ${state.view === 'difficulty' ? 'difficulty' : 'hashrate'}`); text('mining-value', format(source.latest?.[field]));
  $('selected-dot').className = `algorithm-dot ${algorithm.key}`; $('mining-legend').className = `legend-dot algorithm-dot ${algorithm.key}`;
  const movement = change(source.points, field); text('mining-change', finite(movement) ? changeText(movement) : ''); $('mining-change').classList.toggle('down', movement < 0);
  text('mining-average', format(values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)); text('mining-high', format(values.length ? Math.max(...values) : null)); text('mining-low', format(values.length ? Math.min(...values) : null));
  text('mining-description', state.view === 'difficulty' ? 'Mining difficulty' : 'Estimated hashes per second'); text('series-label', algorithm.name);
  renderChart($('mining-chart'), { points: source.points, series: [{ field, name: algorithm.name, color: algorithm.color }], ...(state.data?.range ?? currentRange()), format, utc: state.utc, empty: source.available ? 'No samples in this time period' : 'Algorithm statistics are not available for this period' });
}
function renderTable() {
  const body = $('algorithm-table'); body.replaceChildren();
  algorithms.forEach((algorithm) => {
    const row = document.createElement('tr'); row.classList.toggle('selected-row', algorithm.key === state.algorithm); const name = document.createElement('th'); name.scope = 'row';
    const button = document.createElement('button'); button.className = `snapshot-name ${algorithm.key}`; button.type = 'button'; const dot = document.createElement('span'); dot.className = 'algorithm-dot'; button.append(dot, document.createTextNode(algorithm.name));
    button.onclick = () => { selectAlgorithm(algorithm.key); $('charts').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth' }); }; name.append(button); row.append(name);
    const hash = dataset('hashpower'), difficulty = dataset('difficulty'), field = state.view === 'difficulty' ? algorithm.difficulty : algorithm.key, timestamp = Math.max(hash.latest?.time ?? 0, difficulty.latest?.time ?? 0);
    [compact(hash.latest?.[algorithm.key], 'H/s'), compact(difficulty.latest?.[algorithm.difficulty]), changeText(change(dataset(state.view).points, field)), timestamp ? fullDate(timestamp) : '—'].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }); body.append(row);
  });
}
function updateStatus(error = false) {
  const data = state.data, historical = data && data.range.to < Date.now() - 300_000, age = data?.latestObservedAt ? Date.now() - data.latestObservedAt : Infinity;
  const label = error ? 'Unavailable' : data?.mode === 'demo' ? 'Preview data' : historical ? 'Historical' : age < 180_000 ? 'Live data' : age < Infinity ? 'Collection delayed' : 'No samples';
  const style = error ? 'offline' : data?.mode === 'demo' ? 'demo' : historical ? 'historical' : age < 180_000 ? '' : 'delayed'; $('connection-status').className = `status-badge ${style}`; text('status-label', label);
  text('updated-at', data?.latestObservedAt ? `Last sample ${dateFormat({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(data.latestObservedAt)}${state.utc ? ' UTC' : ''}` : error ? 'Statistics could not be refreshed' : 'No recorded sample in this period');
}
function renderDashboard() {
  syncControls(); renderAlgorithms(); renderMining(); renderTable(); if (!state.data) return;
  const { range, partial, mode, availableRange } = state.data; text('range-label', `${fullDate(range.from)} → ${fullDate(range.to)}${state.utc ? ' UTC' : ''}`);
  text('interval-label', range.grouping === 'month' ? 'Calendar-month averages · UTC' : range.grouping === 'hour' ? 'Hourly averages' : range.grouping === 'day' ? 'Daily averages · UTC' : `${range.intervalMs < 3_600_000 ? `${range.intervalMs / 60_000} min` : `${Number((range.intervalMs / 3_600_000).toFixed(1))} hr`} averages`);
  $('demo-notice').hidden = mode !== 'demo'; const hasSamples = Object.values(state.data.datasets).some((data) => data.latest && Object.entries(data.latest).some(([field, value]) => field !== 'time' && finite(value)));
  $('export').disabled = !hasSamples; $('notice').hidden = hasSamples && !partial; text('notice-text', !hasSamples ? 'No algorithm samples in this time window. Choose an earlier period or view the latest recorded day.' : 'Some algorithm statistics are unavailable for this period. Available data is shown.'); $('latest-data').hidden = hasSamples || !availableRange; updateStatus();
}
async function refreshData() {
  state.controller?.abort(); const controller = new AbortController(); state.controller = controller; syncControls(); document.body.classList.add('is-loading');
  const range = currentRange(), query = new URLSearchParams({ from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), bucket: state.grouping });
  try {
    const response = await fetch(`/api/dashboard?${query}`, { signal: controller.signal, cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Statistics could not be loaded.'); if (controller.signal.aborted) return;
    state.data = data; renderDashboard(); syncUrl(); text('announcement', 'Algorithm charts updated.');
  } catch (error) {
    if (controller.signal.aborted) return; updateStatus(true); $('notice').hidden = false; $('latest-data').hidden = true; text('notice-text', state.data ? 'Unable to refresh. Showing the previous successful time window. Try again shortly.' : error.message); text('announcement', 'Statistics are temporarily unavailable.');
  } finally { if (state.controller === controller) { state.controller = null; document.body.classList.remove('is-loading'); } }
}
function fillDates() { const range = currentRange(); for (const part of ['from', 'to']) { const date = new Date(range[part]); $('date-' + part).value = new Date(range[part] - (state.utc ? 0 : date.getTimezoneOffset() * 60_000)).toISOString().slice(0, 16); } }
document.querySelectorAll('[data-period]').forEach((button) => { button.onclick = () => { state.period = button.dataset.period; state.custom = null; state.auto = state.period !== 'all'; refreshData(); }; });
document.querySelectorAll('[data-view]').forEach((button) => { button.onclick = () => { state.view = button.dataset.view; renderDashboard(); syncUrl(); }; });
$('refresh').onclick = refreshData; $('grouping').onchange = () => { state.grouping = $('grouping').value; refreshData(); };
$('auto-refresh').onclick = () => { state.auto = !state.auto; syncControls(); if (state.auto) refreshData(); };
$('custom-toggle').onclick = () => { const opening = $('date-form').hidden; $('date-form').hidden = !opening; $('custom-toggle').setAttribute('aria-expanded', String(opening)); if (opening) { fillDates(); $('date-from').focus(); } };
$('date-form').onsubmit = (event) => {
  event.preventDefault(); const from = Date.parse($('date-from').value + (state.utc ? 'Z' : '')), to = Date.parse($('date-to').value + (state.utc ? 'Z' : ''));
  if (!finite(from) || !finite(to) || from < 0 || from >= to || to > Date.now() + 300_000 || to - from > 20 * 366 * DAY) { text('date-error', 'Choose a start before the end, with a range of up to 20 years ending no later than now.'); return; }
  text('date-error', ''); state.period = 'custom'; state.custom = { from, to }; state.auto = false; $('date-form').hidden = true; $('custom-toggle').setAttribute('aria-expanded', 'false'); refreshData();
};
$('timezone').onclick = () => { state.utc = !state.utc; renderDashboard(); if (!$('date-form').hidden) fillDates(); syncUrl(); };
$('latest-data').onclick = () => { if (!state.data?.availableRange) return; const to = Math.min(Date.now(), state.data.availableRange.to + 60_000); state.custom = { from: to - DAY, to }; state.period = 'custom'; state.auto = false; refreshData(); };
$('export').onclick = () => {
  if (!state.data) return; const csv = ['time_utc,metric,algorithm,value'];
  for (const [metric, data] of Object.entries(state.data.datasets)) for (const row of data.points) for (const algorithm of algorithms) { const field = metric === 'difficulty' ? algorithm.difficulty : algorithm.key; csv.push(`${new Date(row.time).toISOString()},${metric},${algorithm.name},${finite(row[field]) ? row[field] : ''}`); }
  const url = URL.createObjectURL(new Blob([csv.join('\r\n')], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `verge-algorithms-${new Date(state.data.range.from).toISOString().slice(0, 10)}_${new Date(state.data.range.to).toISOString().slice(0, 10)}.csv`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000); text('announcement', 'Algorithm data exported as CSV.');
};
document.querySelectorAll('.site-header nav a').forEach((link) => { link.onclick = () => document.querySelectorAll('.site-header nav a').forEach((other) => other.classList.toggle('nav-active', other === link)); });
setInterval(() => { if (state.auto && !document.hidden && !state.controller) refreshData(); }, 60_000);
renderDashboard(); refreshData();
