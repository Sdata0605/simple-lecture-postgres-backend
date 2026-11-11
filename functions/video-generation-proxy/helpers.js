// Shared helpers for the video-generation proxy and its action modules (actions/*.js).
// Every action handler receives one context object `c` with:
//   c.body      parsed JSON body of the POST request (object)
//   c.req, c.res  Express request and response
//   c.h         the helpers exported here
// A handler must send exactly one response (c.res.json / c.res.status(...).json / c.res.end).

export const EXTERNAL_PORT = 5006;

export const defaultServerIp = () => process.env.VIDEO_GEN_DEFAULT_SERVER_IP || "";

// Server selection: an absent server_ip means the default server. Any other value must be listed in
// VIDEO_GEN_ALLOWED_SERVER_IPS (the default is always allowed).
export function allowedServerIps() {
  const set = new Set();
  if (defaultServerIp()) set.add(defaultServerIp());
  for (const ip of (process.env.VIDEO_GEN_ALLOWED_SERVER_IPS || "").split(",")) {
    const v = ip.trim();
    if (v) set.add(v);
  }
  return set;
}
export const isAllowedServerIp = (ip) => !ip || allowedServerIps().has(ip);

// Only the GPU server's own ports may be chosen by a caller: 5005 and 5006 plus VIDEO_GEN_ALLOWED_PORTS.
export function allowedPorts() {
  const set = new Set([5005, EXTERNAL_PORT]);
  for (const p of (process.env.VIDEO_GEN_ALLOWED_PORTS || "").split(",")) {
    const n = Number(p.trim());
    if (Number.isInteger(n) && n > 0 && n < 65536) set.add(n);
  }
  return set;
}
export const isValidPort = (port) => {
  if (!port) return true;
  return allowedPorts().has(Number(port));
};

// Rejects traversal and absolute paths in values placed into upstream URLs.
export const isSafeRelativePath = (p) => !String(p).includes("..") && !String(p).startsWith("/") && !String(p).includes("\\");

export const externalApiBase = (serverIp) => `http://${serverIp || defaultServerIp()}:${EXTERNAL_PORT}`;

// Base for submit-style calls: the default port, or the requested target_port on the same server.
export const submitBaseFor = (serverIp, targetPort) =>
  targetPort ? `http://${serverIp || defaultServerIp()}:${targetPort}` : externalApiBase(serverIp);

export const badRequest = (res, message) => res.status(400).json({ error: message });

// Parses an upstream JSON reply, or returns null when the body is not JSON.
export async function jsonOrNull(response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const helpers = {
  EXTERNAL_PORT,
  defaultServerIp,
  isAllowedServerIp,
  isValidPort,
  isSafeRelativePath,
  externalApiBase,
  submitBaseFor,
  badRequest,
  jsonOrNull,
};
