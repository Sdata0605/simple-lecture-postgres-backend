// Applies migrations/realtime-notify.sql (triggers that feed the realtime websocket). Safe to run more than once.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, "..", "migrations", "realtime-notify.sql"), "utf8");
// Target: DATABASE_URL by default; --server uses SERVER_DATABASE_URL.
const toServer = process.argv.includes("--server");
const url = toServer ? process.env.SERVER_DATABASE_URL : process.env.DATABASE_URL;
if (!url) throw new Error(toServer ? "--server needs SERVER_DATABASE_URL" : "DATABASE_URL is not set");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(sql);
  console.log("realtime triggers applied");
} finally {
  await client.end();
}
