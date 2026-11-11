-- Realtime change feed for the tables the UI subscribes to.
-- Each row change sends a NOTIFY on channel 'sl_realtime' with the table, the operation and the row id.
-- The row itself is included when it is small enough for NOTIFY (about 8000 bytes). The realtime server
-- checks each subscriber's access with Postgres RLS before it sends anything, so the notification carries no
-- access decision. Safe to run more than once.

CREATE OR REPLACE FUNCTION public.sl_realtime_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_json jsonb;
  body jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_json := to_jsonb(OLD);
  ELSE
    row_json := to_jsonb(NEW);
  END IF;

  body := jsonb_build_object(
    'schema', TG_TABLE_SCHEMA,
    'table', TG_TABLE_NAME,
    'type', TG_OP,
    'id', row_json->>'id'
  );
  IF octet_length(row_json::text) < 6000 THEN
    body := body || jsonb_build_object('row', row_json);
  END IF;

  PERFORM pg_notify('sl_realtime', body::text);
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'auto_submission_runs',
    'cdn_presentation_refresh_runs',
    'forum_group_messages',
    'forum_groups',
    'gap_patcher_queue',
    'gap_patcher_settings',
    'kannada_queue_items',
    'presentation_update_runs',
    'scheduled_classes',
    'student_lecture_notes',
    'video_generation_jobs'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sl_realtime_notify ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER sl_realtime_notify AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.sl_realtime_notify()', t);
  END LOOP;
END;
$$;
