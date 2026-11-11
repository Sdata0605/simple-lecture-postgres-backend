// Admin log UI entry point: hash router, login, top bar (time window, live, refresh).
import { login, logout, setUnauthorizedHandler, ApiError } from "./api.js";
import { clear, announce } from "./util.js";
import { timeWindow, toLocalInput, fromLocalInput, describeWindow, resolveWindow, fmtIST } from "./time.js";
import { createLogPage, initDetails, closeDetails } from "./logs.js";
import { createDashboard } from "./dashboard.js";

const ROUTES = {
  dashboard: () => createDashboard(),
  "auth/login": () => createLogPage({ title: "Log in", category: "auth", eventPrefix: "login." }),
  "auth/signup": () => createLogPage({ title: "Sign up", category: "auth", eventPrefix: "signup." }),
  "otp/email": () => createLogPage({ title: "Email OTP", category: "otp.email", otp: true }),
  "otp/sms": () => createLogPage({ title: "Mobile OTP", category: "otp.sms", otp: true }),
  "otp/whatsapp": () => createLogPage({ title: "WhatsApp OTP", category: "otp.whatsapp", otp: true }),
  "admin-logins": () => createLogPage({ title: "Admin logins", category: "admin" }),
};
const DEFAULT_ROUTE = "dashboard";
const LIVE_MS = 5000;

const $ = (id) => document.getElementById(id);

let current = null; // { route, page }
let returnTo = DEFAULT_ROUTE;
let liveTimer = null;
let inFlight = false;

function routeFromHash() {
  return location.hash.replace(/^#\/?/, "").replace(/\/$/, "");
}

// ---- login screen

function showLogin() {
  stopLive();
  closeDetails();
  current?.page.destroy();
  current = null;
  $("app-shell").hidden = true;
  $("login-screen").hidden = false;
  document.title = "Sign in · SimpleLecture admin";
  $("login-key").focus();
}

function goLogin() {
  const r = routeFromHash();
  if (r && r !== "login" && ROUTES[r]) returnTo = r;
  if (routeFromHash() !== "login") location.hash = "#/login";
  else showLogin();
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const input = $("login-key");
  const btn = $("login-submit");
  const err = $("login-error");
  err.textContent = "";
  if (!input.value) {
    err.textContent = "Enter the master key.";
    input.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = "Signing in…";
  const key = input.value;
  input.value = ""; // the key is never kept in the page after submit
  try {
    await login(key);
    location.hash = `#/${returnTo || DEFAULT_ROUTE}`;
  } catch (ex) {
    const status = ex instanceof ApiError ? ex.status : 0;
    if (status === 429) err.textContent = "Too many attempts. Wait 10 minutes, then try again.";
    else if (status === 503) err.textContent = "The admin key is not configured on the server (ADMIN_LOG_KEY).";
    else if (status === 0) err.textContent = "Could not reach the server.";
    else err.textContent = "Sign-in failed";
    input.focus();
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

async function onLogout() {
  try {
    await logout();
  } catch {
    // signing out locally is what matters
  }
  returnTo = DEFAULT_ROUTE;
  goLogin();
}

// ---- router

function render() {
  const r = routeFromHash();
  if (r === "login") {
    showLogin();
    return;
  }
  if (!ROUTES[r]) {
    location.replace(`#/${DEFAULT_ROUTE}`);
    return;
  }
  $("login-screen").hidden = true;
  $("app-shell").hidden = false;
  closeDetails();
  current?.page.destroy();
  const page = ROUTES[r]();
  current = { route: r, page };

  for (const a of document.querySelectorAll(".nav-link[data-route]")) {
    if (a.dataset.route === r) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.querySelector(".nav-link[aria-current='page']")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  $("page-title").textContent = page.title;
  document.title = `${page.title} · SimpleLecture admin`;
  updateWindowLabel();
  const root = clear($("page-root"));
  runRefresh(() => page.mount(root));
  $("main").focus({ preventScroll: true });
}

async function runRefresh(fn) {
  inFlight = true;
  try {
    await fn();
  } finally {
    inFlight = false;
    if (liveTimer) $("live-updated").textContent = `Last updated ${fmtIST(new Date().toISOString())}.`;
  }
}

function refreshCurrent({ live = false } = {}) {
  if (!current) return;
  updateWindowLabel();
  const page = current.page;
  runRefresh(() => page.refresh({ live }));
}

// ---- time window toolbar

function updateWindowLabel() {
  $("window-label").textContent = `Window: ${describeWindow()}`;
  for (const b of document.querySelectorAll("[data-preset]")) {
    b.setAttribute("aria-pressed", String(b.dataset.preset === timeWindow.preset));
  }
  // Keep the custom inputs showing the active window, so editing starts from it.
  if (timeWindow.preset) {
    const w = resolveWindow();
    $("range-from").value = toLocalInput(w.from);
    $("range-to").value = toLocalInput(new Date());
  }
}

function onPreset(e) {
  const b = e.target.closest("[data-preset]");
  if (!b) return;
  timeWindow.preset = b.dataset.preset;
  timeWindow.from = null;
  timeWindow.to = null;
  $("range-error").textContent = "";
  refreshCurrent();
  announce(`Window set to ${b.textContent}`);
}

function onCustomRange(e) {
  e.preventDefault();
  const err = $("range-error");
  const from = fromLocalInput($("range-from").value);
  const toRaw = $("range-to").value;
  const to = toRaw ? fromLocalInput(toRaw) : null;
  if (!from) {
    err.textContent = "Enter a valid 'From' date and time.";
    $("range-from").focus();
    return;
  }
  if (toRaw && !to) {
    err.textContent = "Enter a valid 'To' date and time, or leave it empty for now.";
    $("range-to").focus();
    return;
  }
  if (to && to < from) {
    err.textContent = "'To' must be after 'From'.";
    $("range-to").focus();
    return;
  }
  err.textContent = "";
  timeWindow.preset = null;
  timeWindow.from = from;
  timeWindow.to = to;
  refreshCurrent();
  announce("Custom window applied");
}

// ---- live mode

function startLive() {
  stopLive();
  $("live-toggle").checked = true;
  $("live-notice").hidden = false;
  $("live-updated").textContent = "";
  liveTimer = setInterval(() => {
    if (!inFlight) refreshCurrent({ live: true });
  }, LIVE_MS);
}

function stopLive() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  $("live-toggle").checked = false;
  $("live-notice").hidden = true;
}

function onLiveToggle(e) {
  if (e.target.checked) {
    startLive();
    announce("Live mode on. Refreshing every 5 seconds.");
  } else {
    stopLive();
    announce("Live mode off.");
  }
}

// ---- boot

function init() {
  setUnauthorizedHandler(goLogin);
  // The skip link must not change the hash, since the hash is the route.
  document.querySelector(".skip-link").addEventListener("click", (e) => {
    e.preventDefault();
    const target = $("login-screen").hidden ? $("main") : $("login-key");
    target.focus();
    target.scrollIntoView({ block: "start" });
  });
  initDetails();
  $("login-form").addEventListener("submit", onLoginSubmit);
  $("logout-btn").addEventListener("click", onLogout);
  document.querySelector(".presets").addEventListener("click", onPreset);
  $("custom-range").addEventListener("submit", onCustomRange);
  $("live-toggle").addEventListener("change", onLiveToggle);
  $("refresh-btn").addEventListener("click", () => {
    refreshCurrent();
    announce("Refreshing");
  });
  window.addEventListener("hashchange", render);
  if (!location.hash || location.hash === "#" || location.hash === "#/") {
    location.replace(`#/${DEFAULT_ROUTE}`); // fires hashchange, which renders
    return;
  }
  render();
}

init();
