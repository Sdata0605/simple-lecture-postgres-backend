// SMS and WhatsApp OTP delivery.
// MESSAGE_MODE=dry-run (default) never contacts a gateway; it logs the code instead.
// MESSAGE_MODE=live calls Nettyfish (SMS) or Wacto (WhatsApp), as the Supabase functions did.

const isLive = () => process.env.MESSAGE_MODE === "live";

// Messages sent in dry-run mode, kept in memory so tests can read the OTP.
export const sentSms = [];

export async function sendSmsOtp({ cleanPhone, otp, purpose, userName }) {
  const smsText =
    purpose === "login"
      ? `Hello ${userName}, your OTP for logging into Simple Lecture is ${otp}. Please do not share this with anyone. Happy Learning!`
      : `Welcome to Simple Lecture! Use OTP ${otp} to verify your number and create your account. Let's start your learning journey!`;

  if (!isLive()) {
    sentSms.push({ to: `91${cleanPhone}`, purpose, text: smsText, otp });
    console.log(`[sms:dry-run] to=******${cleanPhone.slice(-4)} purpose=${purpose} (OTP sent, code not logged)`);
    return { ok: true, dryRun: true };
  }

  const templateId =
    purpose === "login"
      ? process.env.NETTYFISH_LOGIN_TEMPLATE_ID
      : process.env.NETTYFISH_SIGNUP_TEMPLATE_ID;
  const url = new URL("http://retailsms.nettyfish.com/api/mt/SendSMS");
  url.searchParams.set("user", process.env.NETTYFISH_USER);
  url.searchParams.set("password", process.env.NETTYFISH_PASSWORD);
  url.searchParams.set("senderid", process.env.NETTYFISH_SENDER_ID);
  url.searchParams.set("channel", "Trans");
  url.searchParams.set("DCS", "0");
  url.searchParams.set("flashsms", "0");
  url.searchParams.set("number", `91${cleanPhone}`);
  url.searchParams.set("text", smsText);
  url.searchParams.set("route", "4");
  url.searchParams.set("peid", "1701176984341440636");
  url.searchParams.set("DLT_TE_ID", templateId);

  const res = await fetch(url.toString());
  const body = await res.text();
  // The URL holds the password, so only the masked number and the gateway reply are logged.
  console.log(`[sms:live] to=***${cleanPhone.slice(-4)} purpose=${purpose} http=${res.status} gateway=${body.slice(0, 200)}`);
  try {
    const parsed = JSON.parse(body);
    if (parsed.ErrorCode && parsed.ErrorCode !== "0" && parsed.ErrorCode !== "000") {
      return { ok: false, error: `SMS gateway error: ${parsed.ErrorMessage} (code: ${parsed.ErrorCode})` };
    }
  } catch {
    if (!body.toLowerCase().includes("success")) {
      return { ok: false, error: `Unexpected SMS gateway response: ${body}` };
    }
  }
  return { ok: true };
}

export async function sendWhatsappOtp({ cleanPhone, otp, purpose }) {
  if (!isLive()) {
    sentSms.push({ to: `91${cleanPhone}`, purpose, text: "whatsapp", otp });
    console.log(`[whatsapp:dry-run] to=******${cleanPhone.slice(-4)} purpose=${purpose} (OTP sent, code not logged)`);
    return { ok: true, dryRun: true };
  }

  if (!process.env.WACTO_API_TOKEN) return { ok: false, error: "WhatsApp is not configured on this server." };
  const res = await fetch("https://api.wacto.app/api/v1.0/messages/send-template/917353021234", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WACTO_API_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: `91${cleanPhone}`,
      type: "template",
      template: {
        name: "otp",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: otp }] },
          { type: "button", parameters: [{ type: "text", text: otp }], sub_type: "url", index: "0" },
        ],
      },
    }),
  });
  const body = await res.text();
  console.log(`[whatsapp:live] to=***${cleanPhone.slice(-4)} purpose=${purpose} http=${res.status} gateway=${body.slice(0, 200)}`);
  if (!res.ok) return { ok: false, error: `WhatsApp delivery failed: ${body}` };
  return { ok: true };
}
