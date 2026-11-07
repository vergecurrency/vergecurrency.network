'use strict';

const { definitions } = require('./data');

// Only the explicit --demo preview uses generated numbers; live data never does.
function demoData(range, now = Date.now()) {
  const wave = (time, phase) => 1 + Math.sin(time / 3_600_000 + phase) * .13 + Math.sin(time / 823_000 + phase * 2) * .055;
  const bases = { hashpower: { scrypt: 8.42e12, groestl: 31.8e9, lyra2re: 62.4e9, x17: 1.84e12, blake2s: 218e12 }, difficulty: { scrypt: 285_620, groestl: 1284, lyra2re: 2185, x17: 58_140, blake: 7_124_000 } };
  function values(definition, time) { return Object.fromEntries(definition.fields.map((field, index) => [field, bases[definition.key][field] * wave(time, index)])); }
  let times;
  if (range.grouping === 'month') {
    times = [range.from];
    const date = new Date(range.from);
    for (let time = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); time < range.to;) {
      times.push(time);
      const next = new Date(time); time = Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1);
    }
  } else {
    const count = Math.min(746, Math.max(2, Math.ceil((range.to - range.from) / range.intervalMs) + 1));
    times = Array.from({ length: count }, (_, index) => range.from + index / (count - 1) * (range.to - range.from));
  }
  const datasets = Object.fromEntries(definitions.map((definition) => [definition.key, {
    available: true, latest: { time: range.to, ...values(definition, range.to) },
    points: times.map((time) => ({ time, ...values(definition, time) })),
  }]));
  return { mode: 'demo', generatedAt: new Date(now).toISOString(), range, datasets, availableRange: { from: now - 5 * 365 * 86_400_000, to: now }, partial: false, latestObservedAt: range.to };
}

module.exports = { demoData };
