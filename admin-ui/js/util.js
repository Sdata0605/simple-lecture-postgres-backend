// DOM and formatting helpers. Server text is only ever inserted as text nodes, never as HTML.

// h("div", { class: "x", onclick: fn }, "text", childNode, [more children])
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children) {
    if (c === undefined || c === null) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const dash = "—";
export const orDash = (v) => (v === null || v === undefined || v === "" ? dash : String(v));

// Keys that must never be shown, even if the server missed them.
const SECRET_KEY_RE = /pass|otp|token|secret|key|authorization|cookie/i;

export function redactDetails(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactDetails(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactDetails(v, depth + 1);
    return out;
  }
  return value;
}

export function outcomeBadge(outcome) {
  const known = { success: "Success", failed: "Failed", info: "Info" };
  const label = known[outcome] || orDash(outcome);
  const cls = known[outcome] ? outcome : "info";
  return h("span", { class: `badge badge-${cls}` }, h("span", { class: "badge-dot", "aria-hidden": "true" }), label);
}

// Readable text for API error codes.
const ERROR_TEXT = {
  window_too_large: "This window is too large for 15-minute buckets (limit about 52 days). Choose a shorter range.",
  window_invalid: "The 'To' time is before the 'From' time.",
  from_invalid: "The 'From' time is not valid.",
  to_invalid: "The 'To' time is not valid.",
  q_too_long: "The search text is too long (100 characters at most).",
  q_invalid: "The search text contains characters that are not allowed.",
  cursor_invalid: "The page cursor is no longer valid. Refresh the page.",
  internal_error: "The server hit an internal error. Try again shortly.",
  network: "Could not reach the server. Check the connection and try again.",
  not_found: "That log entry no longer exists.",
};
export function errorText(code) {
  return ERROR_TEXT[code] || `Request failed (${code || "unknown error"}).`;
}

export function announce(text) {
  const el = document.getElementById("sr-status");
  if (!el) return;
  el.textContent = "";
  // A tick later so screen readers notice repeated messages.
  setTimeout(() => {
    el.textContent = text;
  }, 50);
}

export function stateBox(kind, text) {
  return h("div", { class: `state state-${kind}`, role: kind === "error" ? "alert" : null }, text);
}
