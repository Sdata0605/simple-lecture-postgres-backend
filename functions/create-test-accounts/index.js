// Port of supabase/functions/create-test-accounts. This bootstrap tool was disabled in the original
// after its one-shot run, and it stays disabled. The hard-coded tester credentials are not carried over.
import express from "express";

export const router = express.Router();

router.post("/", (_req, res) => {
  res.status(403).type("application/json").send(JSON.stringify({ error: "Disabled" }));
});
