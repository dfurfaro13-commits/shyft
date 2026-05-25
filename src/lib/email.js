// Resend wrapper. In dev (DEV_EMAIL=console) we log instead of sending so the
// magic-link flow is testable without a verified domain.

const RESEND_API = "https://api.resend.com/emails";
const FROM_FALLBACK = "SHIFT <onboarding@resend.dev>";

export async function sendMagicLink(env, { to, link }) {
  return sendLink(env, {
    to,
    subject: "Sign in to SHIFT",
    intro: "Click the button below to sign in to SHIFT.",
    cta: "Sign in to SHIFT",
    link,
  });
}

export async function sendEmailChangeLink(env, { to, link }) {
  return sendLink(env, {
    to,
    subject: "Confirm your new SHIFT email",
    intro: "Click the button below to confirm this is your new SHIFT email address. Until you click, your account email won't change.",
    cta: "Confirm new email",
    link,
  });
}

export async function sendPasswordResetLink(env, { to, link }) {
  return sendLink(env, {
    to,
    subject: "Reset your SHIFT password",
    intro: "Click the button below to set a new SHIFT password. If you didn't ask for this, you can ignore this email — your current password still works.",
    cta: "Set new password",
    link,
  });
}

async function sendLink(env, { to, subject, intro, cta, link }) {
  const text =
    `${intro}\n\nThe link expires in 15 minutes and can only be used once.\n\n` +
    `${link}\n\n` +
    `If you did not request this email, you can safely ignore it.`;
  const html =
    `<p>${intro} The link expires in 15 minutes and can only be used once.</p>` +
    `<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">${cta}</a></p>` +
    `<p style="color:#64748b;font-size:13px">Or paste this URL into your browser:<br/>${link}</p>` +
    `<p style="color:#94a3b8;font-size:12px">If you did not request this email, you can safely ignore it.</p>`;

  if (env.DEV_EMAIL === "console" || !env.RESEND_API_KEY) {
    console.log(`[email:dev] to=${to} subject=${JSON.stringify(subject)} link=${link}`);
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
