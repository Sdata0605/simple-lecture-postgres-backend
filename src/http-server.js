import http from "node:http";

// Node's default header limit is 16 KB, which includes the request line. supabase-js sends a select with an
// `.in(col, [500 ids])` filter as one long GET URL (about 18 KB), and Supabase accepts it, so the limit is raised.
export const MAX_HEADER_SIZE = 64 * 1024;

export function createHttpServer(app) {
  return http.createServer({ maxHeaderSize: MAX_HEADER_SIZE }, app);
}
