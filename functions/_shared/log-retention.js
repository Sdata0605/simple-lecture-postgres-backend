// Retention for public.system_logs: rows older than 14 days are deleted.
// Runs once at startup and then every hour (started from src/index.js, not from createApp,
// so tests do not start timers). Call purgeOldSystemLogs() directly in tests.
import { query } from "./db.js";

export const RETENTION_DAYS = 14;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export async function purgeOldSystemLogs(days = RETENTION_DAYS) {
  const { rowCount } = await query(
    "DELETE FROM public.system_logs WHERE ts < now() - ($1::int * interval '1 day')",
    [days]
  );
  return rowCount;
}

let timer = null;
export function startLogRetention() {
  // Starting twice must not leave a second hourly job running.
  stopLogRetention();
  const run = () =>
    purgeOldSystemLogs().catch((e) =>
      console.log(JSON.stringify({ level: "error", step: "log-retention.failed", message: String(e?.message || e) }))
    );
  run();
  timer = setInterval(run, RETENTION_INTERVAL_MS);
  // unref: the purge timer alone must not keep the process alive.
  timer.unref();
  return timer;
}

export function stopLogRetention() {
  if (timer) clearInterval(timer);
  timer = null;
}
