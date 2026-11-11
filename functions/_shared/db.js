import pg from "pg";

// One shared pool. Locally it points at the test copy; on the server, at the server database.
// Max is 20 because each locked request holds one connection while its handler uses others.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 5000,
});

export const query = (text, params = []) => pool.query(text, params);

// Serialises requests that share a key (for example one email address), so the rate limit
// and attempt counters cannot be raced by parallel requests.
export async function withLock(key, fn) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => {});
    client.release();
  }
}

// Wraps a route handler so it runs under the lock for keyFn(req). An empty key skips locking.
export const lockedBy = (keyFn, handler) => async (req, res) => {
  const key = keyFn(req);
  if (!key) return handler(req, res);
  return withLock(key, () => handler(req, res));
};
