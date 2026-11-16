-- Session revocation for the backend's /auth/v1 routes (not in Supabase; needed by the backend).
-- Each login creates a session_key that stays the same across refresh-token rotation.
-- Access tokens carry it as the `sid` claim; logout adds it to auth_revoked_sessions,
-- and the auth and REST checks reject tokens whose sid is listed there.
ALTER TABLE public.auth_refresh_tokens
  ADD COLUMN IF NOT EXISTS session_key uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE IF NOT EXISTS public.auth_revoked_sessions (
  session_key uuid PRIMARY KEY,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
