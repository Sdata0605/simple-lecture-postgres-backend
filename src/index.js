import "dotenv/config";
import { createApp } from "./app.js";
import { createHttpServer } from "./http-server.js";
import { assertConfigured } from "./config.js";
import { mirrorConsole } from "../functions/_shared/log.js";
import { attachRealtime } from "../functions/realtime/index.js";
// Log retention: deletes system_logs rows older than 14 days at startup and every hour.
import { startLogRetention } from "../functions/_shared/log-retention.js";

mirrorConsole();

assertConfigured();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const server = createHttpServer(createApp()).listen(PORT, HOST, () => {
  console.log(`backend listening on http://${HOST}:${PORT}`);
});
attachRealtime(server);
startLogRetention();

// Daily blog post at 00:30 UTC (the production pg_cron job). BLOG_DAILY_ENABLED=false turns it off.
import { startDailyBlogSchedule } from "../functions/generate-blog-post/scheduler.js";
if (process.env.BLOG_DAILY_ENABLED !== "false") startDailyBlogSchedule({ host: HOST, port: PORT });
