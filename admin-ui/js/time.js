// Time window state and IST formatting. The API speaks UTC ISO; the UI shows Asia/Kolkata.
// IST is a fixed +05:30 offset with no daylight saving, which keeps the conversions exact.

const TZ = "Asia/Kolkata";
const IST_OFFSET = "+05:30";

const fullFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ, year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const shortFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "2-digit", month: "short" });
const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function fmtIST(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${fullFmt.format(d)} IST`;
}
export const fmtClock = (d) => shortFmt.format(d);
export const fmtDay = (d) => dayFmt.format(d);

// Date -> "YYYY-MM-DDTHH:MM" in IST, for datetime-local inputs.
export function toLocalInput(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// "YYYY-MM-DDTHH:MM" typed in IST -> Date, or null when invalid.
export function fromLocalInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value || "")) return null;
  const withSec = value.length === 16 ? `${value}:00` : value;
  const d = new Date(`${withSec}${IST_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function istMidnight(now) {
  const day = toLocalInput(now).slice(0, 10);
  return new Date(`${day}T00:00:00${IST_OFFSET}`);
}

export const PRESETS = {
  "15m": { label: "Last 15 min", from: (n) => new Date(n.getTime() - 15 * 60e3) },
  "1h": { label: "Last hour", from: (n) => new Date(n.getTime() - 60 * 60e3) },
  today: { label: "Today", from: istMidnight },
  "24h": { label: "Last 24 h", from: (n) => new Date(n.getTime() - 24 * 60 * 60e3) },
};

// The current window. Presets are re-evaluated on every fetch so "Last 15 min" keeps moving.
export const timeWindow = { preset: "1h", from: null, to: null };

// Returns { from: Date, to: Date|null, fixed: boolean }. to is null for presets (meaning "now").
export function resolveWindow(now = new Date()) {
  if (timeWindow.preset && PRESETS[timeWindow.preset]) {
    return { from: PRESETS[timeWindow.preset].from(now), to: null, fixed: false };
  }
  return { from: timeWindow.from, to: timeWindow.to, fixed: true };
}

export function describeWindow() {
  const w = resolveWindow();
  if (!w.fixed) return `${PRESETS[timeWindow.preset].label}: since ${fmtIST(w.from.toISOString())}`;
  return `${fmtIST(w.from.toISOString())} to ${w.to ? fmtIST(w.to.toISOString()) : "now"}`;
}
