-- AI Teacher note search functions, copied from the Supabase migration 20261010120000_ai_teacher.sql.
-- Only the two functions and their grants. The backend's ai-teacher route calls them for note search; if they are
-- missing, the route silently answers without course notes. Idempotent (create or replace).

-- search_topic_cards(): hybrid search over topic routing cards (picks the right topics).
create or replace function public.search_topic_cards(
  p_subject_id      uuid,
  p_query_text      text,
  p_query_embedding vector(768) default null,
  p_match_count     integer default 5
)
returns table (
  topic_id      uuid,
  chapter_id    uuid,
  chapter_title text,
  topic_title   text,
  summary       text,
  score         double precision
)
language sql
stable
as $$
  with q as (
    select replace(plainto_tsquery('simple', p_query_text)::text, ' & ', ' | ')::tsquery as tsq
  ),
  kw as (
    select c.topic_id,
           row_number() over (order by ts_rank_cd(c.fts, q.tsq) desc) as rnk
    from public.topic_routing_cards c, q
    where c.subject_id = p_subject_id
      and c.fts @@ q.tsq
    order by ts_rank_cd(c.fts, q.tsq) desc
    limit 20
  ),
  vec as (
    select c.topic_id,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from public.topic_routing_cards c
    where c.subject_id = p_subject_id
      and p_query_embedding is not null
      and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit 20
  )
  select c.topic_id, c.chapter_id, c.chapter_title, c.topic_title, c.summary,
         (coalesce(1.0 / (60 + kw.rnk), 0) + coalesce(1.0 / (60 + vec.rnk), 0))::double precision as score
  from kw
  full outer join vec on vec.topic_id = kw.topic_id
  join public.topic_routing_cards c on c.topic_id = coalesce(kw.topic_id, vec.topic_id)
  order by score desc
  limit p_match_count;
$$;

revoke all on function public.search_topic_cards(uuid, text, vector, integer) from public, anon, authenticated;
grant execute on function public.search_topic_cards(uuid, text, vector, integer) to service_role;

-- search_knowledge_chunks(): the vector branch is skipped when p_query_embedding is null.
create or replace function public.search_knowledge_chunks(
  p_subject_id      uuid,
  p_query_text      text,
  p_query_embedding vector(768),
  p_match_count     integer default 5,
  p_topic_ids       uuid[]  default null
)
returns table (
  id           uuid,
  topic_id     uuid,
  chapter_id   uuid,
  document_id  uuid,
  heading_path text,
  content      text,
  score        double precision
)
language sql
stable
as $$
  with q as (
    select replace(plainto_tsquery('simple', p_query_text)::text, ' & ', ' | ')::tsquery as tsq
  ),
  kw as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.fts, q.tsq) desc) as rnk
    from public.knowledge_chunks c, q
    where c.subject_id = p_subject_id
      and (p_topic_ids is null or c.topic_id = any (p_topic_ids))
      and c.fts @@ q.tsq
    order by ts_rank_cd(c.fts, q.tsq) desc
    limit 30
  ),
  vec as (
    select c.id,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from public.knowledge_chunks c
    where c.subject_id = p_subject_id
      and (p_topic_ids is null or c.topic_id = any (p_topic_ids))
      and p_query_embedding is not null
      and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit 30
  )
  select c.id, c.topic_id, c.chapter_id, c.document_id, c.heading_path, c.content,
         (coalesce(1.0 / (60 + kw.rnk), 0) + coalesce(1.0 / (60 + vec.rnk), 0))::double precision as score
  from kw
  full outer join vec on vec.id = kw.id
  join public.knowledge_chunks c on c.id = coalesce(kw.id, vec.id)
  order by score desc
  limit p_match_count;
$$;

revoke all on function public.search_knowledge_chunks(uuid, text, vector, integer, uuid[]) from public, anon, authenticated;
grant execute on function public.search_knowledge_chunks(uuid, text, vector, integer, uuid[]) to service_role;
