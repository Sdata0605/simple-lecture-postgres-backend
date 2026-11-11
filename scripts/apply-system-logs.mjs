// Applies migrations/system-logs.sql. Refuses to run unless DATABASE_URL points at the test DB.
import "dotenv/config";
import fs from "node:fs";
import pg from "pg";
const url = process.env.DATABASE_URL || "";
if (!/simplelecture_test/.test(url)) throw new Error("Refusing: DATABASE_URL must point at simplelecture_test");
const sql = fs.readFileSync(new URL("../migrations/system-logs.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: url });
await client.connect();
try { await client.query(sql); console.log("system-logs migration applied"); } finally { await client.end(); }
