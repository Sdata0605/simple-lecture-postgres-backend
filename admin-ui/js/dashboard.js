// Dashboard: provider cards, errors per 15 minutes chart and top errors.
import { api, qs, ApiError } from "./api.js";
import { h, svg, clear, orDash, errorText, stateBox } from "./util.js";
import { fmtIST, fmtClock, fmtDay, resolveWindow } from "./time.js";

const BUCKET_MS = 15 * 60e3;
const MAX_DRAWN_BUCKETS = 2000;

// green: reachable and last success newer than last failure
// red: unreachable, or the last failure is newer than the last success
// yellow: everything else (dry-run, no check available, no data)
export function providerHealth(p) {
  const s = p.last_success_at ? Date.parse(p.last_success_at) : null;
  const f = p.last_failure_at ? Date.parse(p.last_failure_at) : null;
  if (p.reachable === false) return "red";
  if (f !== null && (s === null || f > s)) return "red";
  if (p.reachable === true && s !== null) return "green";
  return "yellow";
}
const HEALTH_LABEL = { green: "Healthy", yellow: "Unknown", red: "Failing" };

function providerCard(p) {
  const health = providerHealth(p);
  return h("li", { class: `card provider provider-${health}` },
    h("div", { class: "provider-head" },
      h("h3", null, orDash(p.name)),
      h("span", { class: `health health-${health}` }, h("span", { class: "badge-dot", "aria-hidden": "true" }), HEALTH_LABEL[health])),
    h("dl", { class: "kv kv-compact" },
      h("dt", null, "Live mode"), h("dd", null, p.configured ? "On" : "Off"),
      h("dt", null, "Reachable"), h("dd", null, p.reachable === true ? "Yes" : p.reachable === false ? "No" : "Not checked"),
      h("dt", null, "Last success"), h("dd", null, fmtIST(p.last_success_at)),
      h("dt", null, "Last error"), h("dd", null, fmtIST(p.last_failure_at)),
      p.latency_ms !== null && p.latency_ms !== undefined ? [h("dt", null, "Latency"), h("dd", null, `${p.latency_ms} ms`)] : null),
    p.last_error ? h("p", { class: health === "red" ? "provider-error" : "provider-note muted" }, String(p.last_error).slice(0, 120)) : null);
}

// Fills empty 15-minute slots so the chart has a continuous time axis.
function fillBuckets(summary) {
  const byStart = new Map(summary.buckets.map((b) => [Date.parse(b.start), b]));
  const from = Math.floor(Date.parse(summary.from) / BUCKET_MS) * BUCKET_MS;
  const to = Date.parse(summary.to);
  const out = [];
  for (let t = from; t <= to && out.length < MAX_DRAWN_BUCKETS; t += BUCKET_MS) {
    const b = byStart.get(t);
    out.push({ start: t, failed: b ? b.failed : 0, total: b ? b.total : 0 });
  }
  return out;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return v;
}

function errorChart(buckets) {
  const W = 760, H = 240, L = 44, R = 12, T = 12, B = 44;
  const plotW = W - L - R, plotH = H - T - B;
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.failed)));
  const n = Math.max(1, buckets.length);
  const step = plotW / n;
  const barW = Math.max(1, step * 0.75);
  const total = buckets.reduce((a, b) => a + b.failed, 0);

  const root = svg("svg", {
    viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img",
    "aria-label": `Errors per 15 minutes: ${total} errors across ${buckets.length} intervals, peak ${Math.max(0, ...buckets.map((b) => b.failed))}.`,
  });
  // Y grid and labels
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = T + plotH - (v / max) * plotH;
    root.appendChild(svg("line", { x1: L, x2: W - R, y1: y, y2: y, class: i === 0 ? "axis" : "grid" }));
    root.appendChild(svg("text", { x: L - 6, y: y + 4, "text-anchor": "end", class: "tick" }, Number.isInteger(v) ? v : v.toFixed(1)));
  }
  // Bars
  buckets.forEach((b, i) => {
    if (!b.failed) return;
    const bh = (b.failed / max) * plotH;
    const rect = svg("rect", { x: L + i * step + (step - barW) / 2, y: T + plotH - bh, width: barW, height: bh, rx: Math.min(2, barW / 3), class: "bar" });
    rect.appendChild(svg("title", null, `${fmtDay(new Date(b.start))} ${fmtClock(new Date(b.start))} IST: ${b.failed} errors of ${b.total} events`));
    root.appendChild(rect);
  });
  // X labels: about 6 evenly spaced
  const every = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += every) {
    const d = new Date(buckets[i].start);
    const x = L + i * step + step / 2;
    root.appendChild(svg("line", { x1: x, x2: x, y1: T + plotH, y2: T + plotH + 4, class: "axis" }));
    root.appendChild(svg("text", { x, y: T + plotH + 18, "text-anchor": "middle", class: "tick" }, fmtClock(d)));
    root.appendChild(svg("text", { x, y: T + plotH + 32, "text-anchor": "middle", class: "tick tick-sub" }, fmtDay(d)));
  }
  root.appendChild(svg("text", { x: 12, y: T + plotH / 2, transform: `rotate(-90 12 ${T + plotH / 2})`, "text-anchor": "middle", class: "tick" }, "Errors"));
  return root;
}

function chartTable(buckets) {
  const rows = buckets.filter((b) => b.total > 0);
  return h("details", { class: "fallback" },
    h("summary", null, "Show chart data as a table"),
    rows.length
      ? h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Errors per 15 minutes data" },
        h("table", { class: "log-table" },
          h("thead", null, h("tr", null,
            h("th", { scope: "col" }, "Interval start (IST)"), h("th", { scope: "col" }, "Errors"), h("th", { scope: "col" }, "Total events"))),
          h("tbody", null, rows.map((b) => h("tr", null,
            h("td", { class: "nowrap" }, fmtIST(new Date(b.start).toISOString())),
            h("td", { class: "num" }, b.failed), h("td", { class: "num" }, b.total))))))
      : h("p", { class: "muted" }, "No events in this window."));
}

function topErrors(list) {
  if (!list.length) return stateBox("empty", "No errors in this window");
  return h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Top errors table" },
    h("table", { class: "log-table" },
      h("thead", null, h("tr", null,
        h("th", { scope: "col" }, "Message"), h("th", { scope: "col" }, "Category"), h("th", { scope: "col", class: "num" }, "Count"))),
      h("tbody", null, list.map((e) => h("tr", null,
        h("td", { class: "msg" }, orDash(e.message)), h("td", { class: "mono" }, orDash(e.category)), h("td", { class: "num" }, e.count))))));
}

export function createDashboard() {
  let controller = null;
  let els = {};

  async function loadProviders(signal, live) {
    if (!live) clear(els.providers).appendChild(stateBox("loading", "Checking providers…"));
    try {
      const list = await api("/providers/status", { signal });
      if (signal.aborted) return;
      clear(els.providers);
      if (!Array.isArray(list) || !list.length) {
        els.providers.appendChild(stateBox("empty", "No providers are configured on this server."));
        return;
      }
      const checked = list[0]?.checked_at;
      els.providers.append(
        h("ul", { class: "cards" }, list.map(providerCard)),
        checked ? h("p", { class: "muted small" }, `Checked ${fmtIST(checked)} (cached up to 60 s by the server).`) : null);
    } catch (err) {
      if (err?.name === "AbortError" || (err instanceof ApiError && err.status === 401)) return;
      clear(els.providers).appendChild(stateBox("error", errorText(err.code)));
    }
  }

  async function loadSummary(signal, live) {
    if (!live) {
      clear(els.chart).appendChild(stateBox("loading", "Loading summary…"));
      clear(els.top);
    }
    const w = resolveWindow();
    try {
      const s = await api(`/logs/summary${qs({ bucket: "15m", from: w.from, to: w.to || new Date() })}`, { signal });
      if (signal.aborted) return;
      clear(els.chart);
      clear(els.top);
      const buckets = fillBuckets(s);
      const hasEvents = s.buckets.length > 0;
      if (!hasEvents) els.chart.appendChild(stateBox("empty", "No logs in this window"));
      else {
        els.chart.appendChild(h("div", { class: "chart-wrap" }, errorChart(buckets)));
        if (buckets.length >= MAX_DRAWN_BUCKETS) els.chart.appendChild(h("p", { class: "muted small" }, "Only the first 2,000 intervals are drawn."));
        els.chart.appendChild(chartTable(buckets));
      }
      els.top.appendChild(topErrors(s.top_errors || []));
    } catch (err) {
      if (err?.name === "AbortError" || (err instanceof ApiError && err.status === 401)) return;
      clear(els.chart).appendChild(stateBox("error", errorText(err.code)));
      clear(els.top);
    }
  }

  function load({ live = false } = {}) {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    return Promise.all([loadProviders(signal, live), loadSummary(signal, live)]);
  }

  return {
    title: "Dashboard",
    mount(root) {
      els.providers = h("div");
      els.chart = h("div");
      els.top = h("div");
      root.append(
        h("section", { class: "panel", "aria-labelledby": "h-providers" }, h("h2", { id: "h-providers" }, "Providers"), els.providers),
        h("section", { class: "panel", "aria-labelledby": "h-chart" }, h("h2", { id: "h-chart" }, "Errors per 15 minutes"), els.chart),
        h("section", { class: "panel", "aria-labelledby": "h-top" }, h("h2", { id: "h-top" }, "Top errors"), els.top));
      return load();
    },
    refresh(opts) {
      return load(opts);
    },
    destroy() {
      controller?.abort();
    },
  };
}
