// Structured logs for every step. Each line is JSON with a time, a level, a step name and details.
// Lines go to the console AND to logs/backend-YYYY-MM-DD.log, so you can read the file directly.
// Secrets (passwords, tokens, keys, OTP codes) are never logged. Emails and phones are always masked
// (p***@domain, ******1234), and any e-mail or long digit run inside a text value is masked too.
import fs from "node:fs";
import path from "node:path";
import { logStep, scrubText } from "./system-log.js";

const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(process.cwd(), "logs"));
const SECRET_KEY = /pass|token|secret|key|otp_code|otp$|code$|authorization/i;

const origLog = console.log.bind(console);
const origErr = console.error.bind(console);

// alice@gmail.com -> a***@gmail.com ; 9876543210 -> ******3210
const mask = (v) => {
  if (v === undefined || v === null) return v;
  const s = String(v).trim();
  if (s.includes("@")) {
    const [local, domain] = s.split("@");
    return `${(local || "").slice(0, 1)}***@${domain || ""}`;
  }
  const digits = s.replace(/\D/g, "");
  return digits.length >= 4 ? "******" + digits.slice(-4) : "****";
};

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[redacted]";
    } else if (k === "email" || k === "phone" || k === "phone_number") {
      out[k] = mask(v);
    } else if (v instanceof Error) {
      out[k] = { message: scrubText(v.message), code: v.code, constraint: v.constraint, detail: scrubText(v.detail) };
    } else if (typeof v === "string") {
      out[k] = scrubText(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toFile(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(LOG_DIR, `backend-${day}.log`), text + "\n");
  } catch {
    // logging must never break a request
  }
}

function write(level, step, fields) {
  let line;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, step, ...clean(fields) });
  } catch (e) {
    // Circular or unserialisable fields must not break the request.
    line = JSON.stringify({ ts: new Date().toISOString(), level, step, log_error: String(e?.message || e) });
  }
  (level === "error" ? origErr : origLog)(line);
  toFile(line);
  try {
    logStep(level, step, fields);
  } catch {
    // system log must never break a request
  }
}

// Sends every console.log / console.error line (including the SMS, WhatsApp and mail helpers) to the file too.
export function mirrorConsole() {
  console.log = (...args) => {
    origLog(...args);
    toFile(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args) => {
    origErr(...args);
    toFile(args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
}

export const log = {
  info: (step, fields) => write("info", step, fields),
  warn: (step, fields) => write("warn", step, fields),
  error: (step, fields) => write("error", step, fields),
};
