const NS = 'http://www.w3.org/2000/svg';
let chartId = 0;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function compact(value, unit = '', maximumFractionDigits = 2) {
  if (!finite(value)) return '—';
  const magnitude = Math.abs(value);
  const scales = [[1e15, 'P'], [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
  const [scale, suffix] = scales.find(([size]) => magnitude >= size) ?? [1, ''];
  const text = new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value / scale);
  if (unit === 'H/s' || unit === 'B') return `${text} ${suffix}${unit}`;
  return `${text}${suffix}${unit ? ` ${unit}` : ''}`;
}

function svgNode(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function label(text, attrs) {
  const node = svgNode('text', { class: 'chart-label', ...attrs });
  node.textContent = text;
  return node;
}

function linePath(coordinates) {
  return coordinates.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`).join(' ');
}

function neonGradient(defs, id, color, left, right) {
  const palettes = {
    '#56eeff': ['#7e91ff', '#56eeff', '#b6fff3', '#56eeff', '#d68cff'],
    '#ff62cf': ['#a97bff', '#ff62cf', '#ffc2ee', '#ff78c1', '#ffbf99'],
    '#bd9bff': ['#79bbff', '#bd9bff', '#f1d8ff', '#d48aff', '#ff82d6'],
    '#67f0bf': ['#68c8ff', '#67f0bf', '#c6ffeb', '#6af3dc', '#a59aff'],
    '#ffbd7a': ['#ff78ca', '#ffbd7a', '#fff0b0', '#ffa685', '#ff7ebd'],
  };
  // User-space coordinates keep the gradient visible on perfectly flat lines.
  const gradient = svgNode('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: left, y1: 0, x2: right, y2: 0 });
  const shades = palettes[color.toLowerCase()] ?? ['#b99bff', color, '#d9fff8', color, '#ff8edb'];
  shades.forEach((shade, index) => gradient.append(svgNode('stop', { offset: `${index * 25}%`, 'stop-color': shade })));
  defs.append(gradient);
}

export function sparkline(points, field, color) {
  const svg = svgNode('svg', { viewBox: '0 0 90 26', class: 'spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  const numbers = points.map((row) => row[field]).filter(finite);
  if (!numbers.length) return svg;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const coordinates = [];
  points.forEach((row, index) => {
    if (!finite(row[field])) return;
    const x = index / Math.max(1, points.length - 1) * 88 + 1;
    const y = 23 - (row[field] - min) / (max - min || 1) * 19;
    coordinates.push([x, y]);
  });
  const defs = svgNode('defs'), id = `spark-neon-${++chartId}`;
  neonGradient(defs, id, color, 1, 89);
  const attrs = { d: linePath(coordinates), fill: 'none', stroke: `url(#${id})`, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
  svg.append(defs, svgNode('path', { ...attrs, class: 'spark-neon-glow', 'stroke-width': 3.5 }), svgNode('path', { ...attrs, 'stroke-width': 1.7 }));
  if (coordinates.length === 1) svg.append(svgNode('circle', { cx: coordinates[0][0], cy: coordinates[0][1], r: 1.8, fill: color }));
  return svg;
}

function render(host, options) {
  const { points = [], series, from, to, format = compact, utc = true, empty = 'No samples in this time period' } = options;
  const width = Math.max(220, host.clientWidth);
  const height = Math.max(130, host.clientHeight);
  host._chartSize = `${width}:${height}`;
  host.replaceChildren();
  host.onpointermove = null;
  host.onpointerleave = null;
  host.onkeydown = null;
  const values = series.flatMap(({ field }) => points.map((row) => row[field]).filter(finite));
  if (!values.length) {
    const state = document.createElement('div');
    state.className = 'chart-empty';
    const icon = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': true });
    icon.append(svgNode('path', { d: 'M3 17V5m0 12h18M6 13l4-4 4 3 6-7' }));
    const message = document.createElement('p');
    message.textContent = empty;
    state.append(icon, message);
    host.append(state);
    host.removeAttribute('tabindex');
    return;
  }
  host.tabIndex = 0;
  host.setAttribute('role', 'img');
  const margin = { left: width < 400 ? 49 : 62, right: 12, top: 12, bottom: 29 };
  const right = width - margin.right;
  const bottom = height - margin.bottom;
  let min = Math.min(...values);
  let max = Math.max(...values);
  const padding = (max - min || Math.abs(max) * 0.1 || 1) * 0.15;
  min = Math.max(min >= 0 ? 0 : -Infinity, min - padding);
  max += padding;
  const x = (time) => margin.left + Math.max(0, Math.min(1, (time - from) / (to - from))) * (right - margin.left);
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - margin.top);
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': true });
  const defs = svgNode('defs');
  const id = `chart-area-${++chartId}`;
  const gradient = svgNode('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(svgNode('stop', { offset: '0%', 'stop-color': series[0].color, 'stop-opacity': '.2' }), svgNode('stop', { offset: '100%', 'stop-color': series[0].color, 'stop-opacity': '.005' }));
  defs.append(gradient);
  svg.append(defs);
  for (let index = 0; index < 5; index++) {
    const value = min + (max - min) * index / 4;
    const position = y(value);
    svg.append(svgNode('line', { x1: margin.left, x2: right, y1: position, y2: position, class: 'chart-grid-line' }), label(format(value), { x: margin.left - 10, y: position + 3, 'text-anchor': 'end' }));
  }
  const span = to - from;
  const timeOptions = span > 120 * 86_400_000 ? { month: 'short', year: '2-digit' } : span > 2 * 86_400_000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit', hour12: false };
  const timeFormat = new Intl.DateTimeFormat('en-US', { ...timeOptions, ...(utc ? { timeZone: 'UTC' } : {}) });
  const ticks = width < 420 ? 4 : 6;
  for (let index = 0; index < ticks; index++) {
    const time = from + (to - from) * index / (ticks - 1);
    const position = x(time);
    svg.append(svgNode('line', { x1: position, x2: position, y1: margin.top, y2: bottom, class: 'chart-grid-line', opacity: '.3' }), label(timeFormat.format(time), { x: position, y: height - 6, 'text-anchor': index === 0 ? 'start' : index === ticks - 1 ? 'end' : 'middle' }));
  }
  series.forEach(({ field, color }, seriesIndex) => {
    // Connect recorded samples across empty aggregation buckets. Do not add
    // values to the dataset or extend the trace beyond its actual endpoints.
    const coordinates = points.filter((row) => finite(row[field])).map((row) => [x(row.time), y(row[field])]);
    if (!coordinates.length) return;
    const path = linePath(coordinates), lineId = `${id}-neon-${seriesIndex}`;
    neonGradient(defs, lineId, color, margin.left, right);
    if (seriesIndex === 0 && coordinates.length > 1) svg.append(svgNode('path', { d: `${path} L${coordinates.at(-1)[0]},${bottom} L${coordinates[0][0]},${bottom}Z`, fill: `url(#${id})` }));
    const trace = svgNode('g', { class: 'chart-trace' });
    const attrs = { d: path, fill: 'none', stroke: `url(#${lineId})`, 'stroke-dasharray': 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
    trace.append(
      svgNode('path', { ...attrs, class: 'chart-neon-halo' }),
      svgNode('path', { ...attrs, class: 'chart-neon-bloom' }),
      svgNode('path', { ...attrs, class: 'chart-data-line' }),
      svgNode('path', { ...attrs, class: 'chart-neon-core', stroke: '#f1fcff' }),
    );
    if (coordinates.length === 1) trace.append(svgNode('circle', { cx: coordinates[0][0], cy: coordinates[0][1], r: 3, fill: '#eaffff', stroke: color, 'stroke-width': 1.5 }));
    svg.append(trace);
  });
  const crosshair = svgNode('line', { x1: 0, x2: 0, y1: margin.top, y2: bottom, stroke: '#7893ac', 'stroke-dasharray': '3 3', visibility: 'hidden' });
  const markers = series.map(({ color }) => svgNode('circle', { r: 3.5, fill: '#0c1723', stroke: color, 'stroke-width': 2, visibility: 'hidden' }));
  svg.append(crosshair, ...markers);
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  host.append(svg, tooltip);
  // Hover and keyboard navigation snap to observed samples, including when the
  // pointer is above a connected gap. Missing values remain missing in exports.
  const observed = points.filter((row) => series.some(({ field }) => finite(row[field])));
  let selected = observed.length - 1;
  const detailFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, ...(utc ? { timeZone: 'UTC' } : {}) });
  function show(index) {
    selected = Math.max(0, Math.min(observed.length - 1, index));
    const row = observed[selected];
    const position = x(row.time);
    crosshair.setAttribute('x1', position);
    crosshair.setAttribute('x2', position);
    crosshair.setAttribute('visibility', 'visible');
    tooltip.replaceChildren();
    const time = document.createElement('time');
    time.textContent = `${detailFormat.format(row.time)}${utc ? ' UTC' : ''}`;
    tooltip.append(time);
    series.forEach(({ field, name }, index) => {
      const valid = finite(row[field]);
      markers[index].setAttribute('visibility', valid ? 'visible' : 'hidden');
      if (valid) { markers[index].setAttribute('cx', position); markers[index].setAttribute('cy', y(row[field])); }
      const line = document.createElement('div');
      line.className = 'tooltip-row';
      const title = document.createElement('span');
      const value = document.createElement('strong');
      title.textContent = name;
      value.textContent = valid ? format(row[field]) : '—';
      line.append(title, value);
      tooltip.append(line);
    });
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(0, Math.min(width - tooltip.offsetWidth, position + 12))}px`;
    tooltip.style.top = '8px';
  }
  host.onpointermove = (event) => {
    const px = event.clientX - host.getBoundingClientRect().left;
    const timestamp = from + (px - margin.left) / (right - margin.left) * (to - from);
    let index = 0;
    let distance = Infinity;
    observed.forEach((row, candidate) => { const next = Math.abs(row.time - timestamp); if (next < distance) { distance = next; index = candidate; } });
    show(index);
  };
  host.onpointerleave = host.onblur = () => { tooltip.hidden = true; crosshair.setAttribute('visibility', 'hidden'); markers.forEach((marker) => marker.setAttribute('visibility', 'hidden')); };
  host.onkeydown = (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowLeft') show(selected - 1);
    if (event.key === 'ArrowRight') show(selected + 1);
    if (event.key === 'Home') show(0);
    if (event.key === 'End') show(observed.length - 1);
    if (event.key === 'Escape') host.onblur();
  };
}

const observer = new ResizeObserver((entries) => {
  entries.forEach(({ target }) => {
    const next = `${Math.max(220, target.clientWidth)}:${Math.max(130, target.clientHeight)}`;
    if (target._chartOptions && next !== target._chartSize) render(target, target._chartOptions);
  });
});

export function renderChart(host, options) {
  if (!host._chartOptions) observer.observe(host);
  host._chartOptions = options;
  render(host, options);
}
