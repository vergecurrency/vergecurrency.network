'use strict';

function startJob(name, collect, intervalMs, {
  logger = console, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let stopped = false;
  let timer;
  let pending;
  async function tick() {
    try {
      await collect();
      logger.log(`[${name}] Wrote points to database.`);
    } catch (error) {
      logger.error(`[${name}] ${error.message}`);
    } finally {
      // Schedule only after completion. Slow requests cannot overlap themselves.
      if (!stopped) timer = setTimer(() => { pending = tick(); }, intervalMs - (now() % intervalMs));
    }
  }
  pending = tick();
  return {
    async stop() {
      stopped = true;
      clearTimer(timer);
      await pending;
    },
  };
}

module.exports = { startJob };
