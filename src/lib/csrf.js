// SameSite=Lax blocks most cross-site POSTs but old browsers still allow them.
// We require a custom header on every state-changing endpoint — it can't be set
// by an HTML form, so a malicious cross-origin page can't forge it.

export function requireCsrfHeader(req) {
  const v = req.headers.get("X-Requested-With");
  if (v !== "shift") {
    return new Response(JSON.stringify({ error: "csrf" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
