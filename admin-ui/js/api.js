// Thin fetch wrapper for /admin/api. Same origin, so the httpOnly sl_admin cookie is sent.
// Nothing secret is ever logged, stored or placed in a URL.

const BASE = "/admin/api";

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function readError(res) {
  try {
    const body = await res.json();
    return body && typeof body.error === "string" ? body.error : `http_${res.status}`;
  } catch {
    return `http_${res.status}`;
  }
}

// opts: { method, body, signal, raw }. raw returns the Response for downloads.
export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method: opts.method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(0, "network");
  }
  if (!res.ok) {
    const code = await readError(res);
    // Login handles its own 401; any other 401 means the session ended.
    if (res.status === 401 && path !== "/login") onUnauthorized();
    throw new ApiError(res.status, code);
  }
  if (opts.raw) return res;
  return res.json();
}

// Builds a query string from filter values. Only times, filters and cursors go here.
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    sp.set(k, v instanceof Date ? v.toISOString() : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const login = (key) => api("/login", { method: "POST", body: { key } });
export const logout = () => api("/logout", { method: "POST" });
