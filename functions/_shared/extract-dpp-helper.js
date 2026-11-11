// Shared AI endpoint helpers for the extract-* functions. Ported from the config blocks that were
// repeated in the Supabase functions. The provider and key come from the ai_settings row
// 'ai_api_config'. Keys are never logged or returned.
import { query } from "./db.js";

// Tests replace hooks.fetch with a stub, and hooks.endpoint with a fixed endpoint (null = not configured).
export const hooks = { fetch: null, endpoint: undefined };

export const hookedFetch = (...args) => (hooks.fetch ?? fetch)(...args);

// { apiUrl, apiKey, model, provider } for the enabled provider, or null.
export function endpointFromConfig(config) {
  if (config?.enabled && config?.provider === "openrouter" && config?.openrouter_api_key) {
    return {
      apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: config.openrouter_api_key,
      model: config.default_model || "google/gemini-2.5-flash",
      provider: "openrouter",
    };
  }
  if (config?.enabled && config?.provider === "google" && config?.google_api_key) {
    return {
      apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: config.google_api_key,
      model: config.default_model || "gemini-2.5-flash",
      provider: "google",
    };
  }
  if (config?.enabled && config?.provider === "openai" && config?.openai_api_key) {
    return {
      apiUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: config.openai_api_key,
      model: config.default_model || "gpt-4o-mini",
      provider: "openai",
    };
  }
  return null;
}

// Reads the admin AI settings. Throws on a database error.
export async function loadAiEndpoint() {
  if (hooks.endpoint !== undefined) return hooks.endpoint;
  const { rows } = await query(
    "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1"
  );
  return endpointFromConfig(rows[0]?.setting_value);
}

// POST a chat-completions body to the configured endpoint. body.model must be set by the caller.
export function postChat(endpoint, body) {
  return hookedFetch(endpoint.apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Multi-row INSERT. Values that are objects must already be JSON strings (for jsonb columns).
export async function insertRows(table, columns, rows) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map(
    (r) => `(${columns.map((c) => {
      params.push(r[c] === undefined ? null : r[c]);
      return `$${params.length}`;
    }).join(", ")})`
  );
  await query(`INSERT INTO public.${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, params);
}
