import nodemailer from "nodemailer";

const maskAddr = (a) => String(a || "").replace(/^(.)[^@]*(@.*)$/, "$1***$2");

// Messages sent in dry-run mode, kept in memory so tests can read the OTP without a mailbox.
export const sentMessages = [];

// MAIL_MODE=dry-run (default) never sends. MAIL_MODE=smtp sends for real.
export async function sendMail({ to, subject, html, text }) {
  if ((process.env.MAIL_MODE || "dry-run") !== "smtp") {
    sentMessages.push({ to, subject, text, html, at: Date.now() });
    console.log(`[mail:dry-run] to=${maskAddr(to)} subject="${subject}" (body not logged)`);
    return { dryRun: true };
  }
  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const info = await transporter.sendMail({
    from: '"SimpleLecture" <notifications@simplelecture.com>',
    to,
    subject,
    html,
    text,
  });
  console.log(`[mail:smtp] to=${maskAddr(to)} accepted=${info.accepted?.length ?? 0} messageId=${info.messageId}`);
  return info;
}
