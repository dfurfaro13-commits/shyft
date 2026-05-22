// Single Worker that fronts the Cloudflare static-assets binding.
// /api/* → API handler. Everything else falls through to the assets binding,
// which serves index.html (the built app) at /.
//
// Apex → www canonicalization: shift-scheduling.com 301s to www.shift-scheduling.com
// so cookies and sessions live on one host. APP_URL (used in magic-link emails) is
// also www, so this keeps every URL in the app consistent.

import { handleApi } from "./src/api/router.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.hostname === "shift-scheduling.com") {
      url.hostname = "www.shift-scheduling.com";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
