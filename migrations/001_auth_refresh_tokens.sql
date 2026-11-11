-- Refresh tokens for the backend's /auth/v1 routes. Not in Supabase; needed by the backend.
-- Points at auth.users (not app.users), so it works with the migrated Supabase auth schema.
CREATE TABLE IF NOT EXISTS public.auth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_user_idx ON public.auth_refresh_tokens(user_id);
