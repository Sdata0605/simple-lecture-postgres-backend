-- TEST COPY ONLY. These triggers call Supabase edge functions over HTTP (net.http_post).
-- The local copy cannot run them, and they would send real emails. Never run this on the server
-- until those triggers are replaced by backend code.
ALTER TABLE public.profiles DISABLE TRIGGER on_profile_created_send_welcome_email;
ALTER TABLE public.blog_posts DISABLE TRIGGER on_blog_post_inserted;
ALTER TABLE public.blog_posts DISABLE TRIGGER on_blog_post_published;
