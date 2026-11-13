// CORS_ORIGINS is a comma-separated allowlist of browser origins (for example https://simplelecture.com).
// When it is unset every origin is allowed (local development). Requests without an Origin header
// (server to server, curl) are always allowed; browsers from any other origin get no CORS headers.
export function corsOptions(env = process.env) {
  const allowed = (env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return { origin: true, credentials: true };
  return { origin: (origin, cb) => cb(null, !origin || allowed.includes(origin)), credentials: true };
}
