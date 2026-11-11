-- System logs: request, auth, OTP and provider events, plus frontend error reports.
-- Read only by the admin API (backend). RLS is on with no policies, so anon and
-- authenticated roles cannot read or write this table through /rest/v1.
-- Rows older than 14 days are deleted by the backend retention job (functions/_shared/log-retention.js).
CREATE TABLE IF NOT EXISTS public.system_logs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL,
  event text NOT NULL,
  status_code int NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failed', 'info')),
  message text NOT NULL DEFAULT '',
  masked_identifier text NULL,
  request_id text NULL,
  duration_ms int NULL,
  details jsonb NULL
);
CREATE INDEX IF NOT EXISTS system_logs_ts_idx ON public.system_logs (ts);
CREATE INDEX IF NOT EXISTS system_logs_category_ts_idx ON public.system_logs (category, ts);
CREATE INDEX IF NOT EXISTS system_logs_outcome_ts_idx ON public.system_logs (outcome, ts);
CREATE INDEX IF NOT EXISTS system_logs_request_id_idx ON public.system_logs (request_id);
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.system_logs FROM anon, authenticated;
