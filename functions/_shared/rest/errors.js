// PostgREST-shaped errors: { code, details, hint, message }, the body supabase-js expects.
export class RestError extends Error {
  constructor(status, message, { code = "PGRST100", details = null, hint = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

// Maps a database error to a REST error. Returns null for unexpected errors (they become 500 without detail).
// As in PostgREST, a permission failure is 401 for the anon role and 403 for a logged-in user.
// RAISE EXCEPTION without a code (P0001) is a 400, as PostgREST reports it.
export function toRestError(err, caller) {
  if (err instanceof RestError) return err;
  const state = String(err?.code || "");
  // As in PostgREST, unique and foreign key violations are 409 (for example a course_categories row naming a missing category).
  if (state === "23505" || state === "23503") return new RestError(409, err.message, { code: state, details: err.detail, hint: err.hint });
  if (state === "42501") {
    const status = caller?.role === "anon" ? 401 : 403;
    return new RestError(status, err.message, { code: state });
  }
  if (/^(P0|21|22|23|42)/.test(state)) return new RestError(400, err.message, { code: state, details: err.detail, hint: err.hint });
  return null;
}
