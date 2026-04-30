// Resend wrapper. In dev (DEV_EMAIL=console) we log instead of sending so the
// magic-link flow is testable without a verified domain.

const RESEND_API = "https://api.resend.com/emails";
const FROM_FALLBACK = "SHIFT <onboarding@resend.dev>";

export async function sendMagicLink(env, { to, link }) {
  const subject = "Sign in to SHIFT";
  const text =
    `Click the link below to sign in to SHIFT. The link expires in 15 minutes and can only be used once.\n\n` +
    `${link}\n\n` +
    `If you did not request this email, you can safely ignore it.`;
  const html =
    `<p>Click the button below to sign in to SHIFT. The link expires in 15 minutes and can only be used once.</p>` +
    `<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">Sign in to SHIFT</a></p>` +
    `<p style="color:#64748b;font-size:13px">Or paste this URL into your browser:<br/>${link}</p>` +
    `<p style="color:#94a3b8;font-size:12px">If you did not request this email, you can safely ignore it.</p>`;

  if (env.DEV_EMAIL === "console" || !env.RESEND_API_KEY) {
    console.log(`[email:dev] to=${to} link=${link}`);
    return;
  }

  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || FROM_FALLBACK,
      to: [to],
      subject,
      text,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend send failed: ${res.status} ${body}`);
  }
}
