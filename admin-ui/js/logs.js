// Log list pages (Log in, Sign up, OTP pages, Admin logins) and the details sheet.
import { api, qs, ApiError } from "./api.js";
import { h, clear, orDash, outcomeBadge, redactDetails, errorText, announce, stateBox } from "./util.js";
import { fmtIST, resolveWindow } from "./time.js";

const PAGE_SIZE = 100;
// Pages filtered by event prefix scan more rows per request, because the API has no event filter.
const PREFIX_PAGE_SIZE = 500;
const PREFIX_MAX_REQUESTS = 10;
const PREFIX_TARGET = 50;

// Filters are shared across log pages so switching pages keeps them.
const filters = { errorsOnly: false, statusClass: "", q: "" };

export function createLogPage(config) {
  const { category, eventPrefix, otp } = config;
  let root = null;
  let controller = null;
  let items = [];
  let cursor = null;
  let snapshot = null; // { from, to } frozen at the first page so Load more stays consistent
  let scanned = 0;
  let els = {};

  const matches = (it) => !eventPrefix || (typeof it.event === "string" && it.event.startsWith(eventPrefix));

  function baseParams() {
    return {
      category,
      from: snapshot.from,
      to: snapshot.to,
      errors_only: filters.errorsOnly ? "true" : undefined,
      status_class: filters.statusClass || undefined,
      q: filters.q.trim() || undefined,
    };
  }

  // Fetches until enough matching rows are found (prefix pages) or one page (others).
  async function fetchMore(startCursor, signal) {
    const out = [];
    let next = startCursor;
    let requests = 0;
    const limit = eventPrefix ? PREFIX_PAGE_SIZE : PAGE_SIZE;
    do {
      const body = await api(`/logs${qs({ ...baseParams(), limit, cursor: next })}`, { signal });
      requests += 1;
      scanned += body.items.length;
      out.push(...body.items.filter(matches));
      next = body.next_cursor;
    } while (eventPrefix && next && out.length < PREFIX_TARGET && requests < PREFIX_MAX_REQUESTS);
    return { found: out, next };
  }

  function buildFilters() {
    const errorsOnly = h("input", { id: "f-errors", type: "checkbox", checked: filters.errorsOnly });
    const status = h("select", { id: "f-status" },
      h("option", { value: "" }, "Any"),
      h("option", { value: "2xx" }, "2xx"),
      h("option", { value: "4xx" }, "4xx"),
      h("option", { value: "5xx" }, "5xx"));
    status.value = filters.statusClass;
    const search = h("input", {
      id: "f-q", type: "search", maxlength: "100", autocomplete: "off", spellcheck: "false",
      placeholder: "Masked identifier or request ID",
    });
    search.value = filters.q;

    const apply = () => {
      filters.errorsOnly = errorsOnly.checked;
      filters.statusClass = status.value;
      filters.q = search.value;
      loadFirst();
    };
    errorsOnly.addEventListener("change", apply);
    status.addEventListener("change", apply);

    const exportMsg = h("p", { class: "export-msg muted", role: "status" });
    const csvBtn = h("button", { type: "button", class: "btn" }, "Export CSV");
    const jsonBtn = h("button", { type: "button", class: "btn" }, "Export JSON");
    csvBtn.addEventListener("click", () => doExport("csv", csvBtn, exportMsg));
    jsonBtn.addEventListener("click", () => doExport("json", jsonBtn, exportMsg));

    const form = h("form", { class: "filters", "aria-label": "Log filters", novalidate: true },
      h("div", { class: "field field-inline" }, errorsOnly, h("label", { for: "f-errors" }, "Errors only")),
      h("div", { class: "field" }, h("label", { for: "f-status" }, "Status class"), status),
      h("div", { class: "field field-grow" }, h("label", { for: "f-q" }, "Search"), search),
      h("button", { type: "submit", class: "btn btn-primary" }, "Search"),
      h("div", { class: "export-btns" }, csvBtn, jsonBtn));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      apply();
    });
    return h("div", null, form, exportMsg);
  }

  function row(it) {
    const open = () => openDetails(it, { otp });
    const btn = h("button", { type: "button", class: "linklike", "aria-label": `Details for ${it.event || "event"} at ${fmtIST(it.ts)}` }, fmtIST(it.ts));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      open();
    });
    const tr = h("tr", { class: "clickable" },
      h("td", { class: "nowrap" }, btn),
      h("td", { class: "num" }, orDash(it.status_code)),
      h("td", null, outcomeBadge(it.outcome)),
      h("td", { class: "msg" }, h("span", null, orDash(it.message)),
        it.event && it.event !== it.message ? h("span", { class: "event muted" }, it.event) : null),
      h("td", { class: "mono" }, orDash(it.masked_identifier)),
      h("td", { class: "num" }, orDash(it.duration_ms)),
      h("td", { class: "mono" }, orDash(it.request_id)));
    tr.addEventListener("click", open);
    return tr;
  }

  function renderResults() {
    clear(els.results);
    if (!items.length) {
      els.results.appendChild(stateBox("empty", "No logs in this window"));
    } else {
      const table = h("table", { class: "log-table" },
        h("caption", { class: "visually-hidden" }, `${config.title} log entries, newest first`),
        h("thead", null, h("tr", null,
          h("th", { scope: "col" }, "Time (IST)"),
          h("th", { scope: "col" }, "Status"),
          h("th", { scope: "col" }, "Outcome"),
          h("th", { scope: "col" }, "Message"),
          h("th", { scope: "col" }, "Masked identifier"),
          h("th", { scope: "col" }, "Duration (ms)"),
          h("th", { scope: "col" }, "Request ID"))),
        h("tbody", null, items.map(row)));
      els.results.appendChild(h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": `${config.title} logs table` }, table));
    }
    const countText = `${items.length} ${items.length === 1 ? "entry" : "entries"} shown` +
      (eventPrefix ? ` (filtered by event "${eventPrefix}*" from ${scanned} auth rows scanned)` : "");
    const footer = h("div", { class: "list-footer" }, h("span", { class: "muted" }, countText));
    if (cursor) {
      const more = h("button", { type: "button", class: "btn" }, "Load more");
      more.addEventListener("click", () => loadMore(more));
      footer.appendChild(more);
    }
    els.results.appendChild(footer);
  }

  function showError(err) {
    clear(els.results);
    els.results.appendChild(stateBox("error", errorText(err.code)));
  }

  async function loadFirst({ live = false } = {}) {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const w = resolveWindow();
    snapshot = { from: w.from, to: w.to || new Date() };
    scanned = 0;
    if (!live || !items.length) {
      clear(els.results);
      els.results.appendChild(stateBox("loading", "Loading logs…"));
    }
    els.results.setAttribute("aria-busy", "true");
    try {
      const { found, next } = await fetchMore(undefined, signal);
      if (signal.aborted) return;
      items = found;
      cursor = next;
      renderResults();
      if (!live) announce(`${items.length} log entries loaded`);
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (err instanceof ApiError && err.status === 401) return;
      items = [];
      showError(err);
    } finally {
      if (!signal.aborted) els.results.removeAttribute("aria-busy");
    }
  }

  async function loadMore(btn) {
    btn.disabled = true;
    btn.textContent = "Loading…";
    const signal = controller?.signal;
    try {
      const { found, next } = await fetchMore(cursor, signal);
      if (signal?.aborted) return;
      items = items.concat(found);
      cursor = next;
      renderResults();
      announce(`${found.length} more entries loaded`);
    } catch (err) {
      if (err?.name === "AbortError" || (err instanceof ApiError && err.status === 401)) return;
      btn.disabled = false;
      btn.textContent = "Load more";
      els.results.appendChild(stateBox("error", errorText(err.code)));
    }
  }

  async function doExport(format, btn, msg) {
    btn.disabled = true;
    msg.textContent = `Preparing ${format.toUpperCase()} export…`;
    try {
      if (!snapshot) snapshot = { from: resolveWindow().from, to: new Date() };
      // Prefix pages fetch JSON and filter in the browser, since the API cannot filter by event.
      const serverFormat = eventPrefix ? "json" : format;
      const res = await api(`/logs/export${qs({ ...baseParams(), format: serverFormat })}`, { raw: true });
      const truncated = res.headers.get("X-Export-Truncated") === "true";
      const cd = res.headers.get("Content-Disposition") || "";
      let name = (/filename="([^"]+)"/.exec(cd) || [])[1] || `admin-logs.${format}`;
      let blob;
      let count = null;
      if (eventPrefix) {
        const rows = (await res.json()).filter(matches);
        count = rows.length;
        name = name.replace(/\.json$/, `-${eventPrefix.replace(/\W/g, "")}.${format}`);
        blob = format === "json"
          ? new Blob([JSON.stringify(rows)], { type: "application/json" })
          : new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
      } else {
        blob = await res.blob();
      }
      download(blob, name);
      msg.textContent = `Downloaded ${name}${count !== null ? ` (${count} rows)` : ""}.` +
        (truncated ? " The export hit the 10,000 row limit; narrow the window for the rest." : "");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      msg.textContent = `Export failed: ${errorText(err.code)}`;
    } finally {
      btn.disabled = false;
    }
  }

  return {
    title: config.title,
    mount(el) {
      root = el;
      els.results = h("div", { class: "results", "aria-live": "off" });
      root.append(buildFilters(), els.results);
      return loadFirst();
    },
    refresh({ live = false } = {}) {
      return loadFirst({ live });
    },
    destroy() {
      controller?.abort();
      root = null;
    },
  };
}

// ---- export helpers

const CSV_COLUMNS = ["id", "ts", "category", "event", "outcome", "status_code", "message",
  "masked_identifier", "request_id", "duration_ms", "details"];

// Same rules as the server: every cell quoted, formula-looking cells prefixed with an apostrophe.
function csvCell(value) {
  let s = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^\s*[=+\-@]|^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, class: "visually-hidden" });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- details sheet

let detailsController = null;

export function closeDetails() {
  const dlg = document.getElementById("details-dialog");
  detailsController?.abort();
  if (dlg?.open) dlg.close();
}

export function initDetails() {
  const dlg = document.getElementById("details-dialog");
  document.getElementById("details-close").addEventListener("click", closeDetails);
  // Click on the backdrop closes the sheet.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeDetails();
  });
  dlg.addEventListener("close", () => detailsController?.abort());
}

function field(label, value, cls) {
  return [h("dt", null, label), h("dd", { class: cls }, value)];
}

async function openDetails(item, { otp }) {
  const dlg = document.getElementById("details-dialog");
  const body = clear(document.getElementById("details-body"));
  detailsController?.abort();
  detailsController = new AbortController();
  const { signal } = detailsController;
  body.appendChild(stateBox("loading", "Loading details…"));
  if (!dlg.open) dlg.showModal();
  document.getElementById("details-title").focus();

  try {
    const full = await api(`/logs/${encodeURIComponent(item.id)}`, { signal });
    if (signal.aborted) return;
    clear(body);
    body.appendChild(h("dl", { class: "kv" },
      field("Time (IST)", fmtIST(full.ts)),
      field("Outcome", outcomeBadge(full.outcome)),
      field("Status", orDash(full.status_code)),
      field("Category", orDash(full.category)),
      field("Event", orDash(full.event), "mono"),
      field("Masked identifier", orDash(full.masked_identifier), "mono"),
      field("Duration (ms)", orDash(full.duration_ms)),
      field("Request ID", orDash(full.request_id), "mono")));
    body.appendChild(h("h3", null, "Message"));
    body.appendChild(h("p", { class: "full-message" }, orDash(full.message)));
    body.appendChild(h("h3", null, "Details"));
    const details = full.details === null || full.details === undefined ? null : redactDetails(full.details);
    body.appendChild(details === null
      ? h("p", { class: "muted" }, "No details recorded.")
      : h("pre", { class: "json", tabindex: "0" }, JSON.stringify(details, null, 2)));

    if (otp) {
      body.appendChild(h("h3", null, "Request timeline"));
      const tl = h("div", null, stateBox("loading", "Loading timeline…"));
      body.appendChild(tl);
      await renderTimeline(tl, full, signal);
    }
  } catch (err) {
    if (err?.name === "AbortError" || (err instanceof ApiError && err.status === 401)) return;
    clear(body);
    body.appendChild(stateBox("error", errorText(err.code)));
  }
}

async function renderTimeline(container, item, signal) {
  if (!item.request_id) {
    clear(container).appendChild(h("p", { class: "muted" }, "This entry has no request ID."));
    return;
  }
  const t = new Date(item.ts).getTime();
  const span = 2 * 60 * 60e3;
  try {
    const body = await api(`/logs${qs({
      q: item.request_id, from: new Date(t - span), to: new Date(t + span), limit: 100,
    })}`, { signal });
    if (signal.aborted) return;
    const events = body.items
      .filter((r) => r.request_id === item.request_id)
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
    clear(container);
    if (!events.length) {
      container.appendChild(h("p", { class: "muted" }, "No other events share this request ID."));
      return;
    }
    container.appendChild(h("ol", { class: "timeline" }, events.map((ev) =>
      h("li", { class: ev.id === item.id ? "is-current" : null, "aria-current": ev.id === item.id ? "true" : null },
        h("div", { class: "tl-head" },
          h("span", { class: "nowrap" }, fmtIST(ev.ts)),
          outcomeBadge(ev.outcome),
          h("span", { class: "mono" }, `${orDash(ev.category)} / ${orDash(ev.event)}`),
          ev.status_code ? h("span", { class: "muted" }, `HTTP ${ev.status_code}`) : null),
        h("div", { class: "tl-msg" }, orDash(ev.message))))));
  } catch (err) {
    if (err?.name === "AbortError" || (err instanceof ApiError && err.status === 401)) return;
    clear(container).appendChild(stateBox("error", errorText(err.code)));
  }
}
