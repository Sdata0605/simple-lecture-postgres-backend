// Push notifications for audio reminders.
// The original sent these through send-push-notification, which is one of the five functions
// removed from the repo. Until a push provider is chosen, nothing is sent and the caller is told.
// Set PUSH_WEBHOOK_URL to a delivery endpoint to enable it: it receives { user_id, data } as JSON.

const PUSH_TIMEOUT_MS = 15_000;

export async function sendAudioPush(userId, items) {
  const url = process.env.PUSH_WEBHOOK_URL;
  if (!url) return { ok: false, reason: "push_not_configured" };
  const payloadItems = items
    .slice()
    .sort((a, b) => a.fireAt.localeCompare(b.fireAt))
    .map(({ rid, hash, url: audioUrl, fmt, fireAt }) => ({ rid, hash, url: audioUrl, fmt, fireAt }));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        data_only: true,
        data: { type: "reminder_audio", items: JSON.stringify(payloadItems) },
      }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    return { ok: res.ok, reason: res.ok ? null : `push_http_${res.status}` };
  } catch {
    return { ok: false, reason: "push_network_error" };
  }
}
