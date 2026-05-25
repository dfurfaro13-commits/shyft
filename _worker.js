// Single Worker that fronts the Cloudflare static-assets binding.
// /api/* → API handler. Everything else falls through to the assets binding,
// which serves index.html (the built app) at /.
//
// Both apex (shift-scheduling.com) and www.shift-scheduling.com are bound as custom
// domains and serve the app directly — we deliberately don't redirect at the Worker
// level because cross-origin 301s trigger CORS preflight failures if a service
// worker or browser cache keeps a user pinned to the apex. Cookies use Domain=
// shift-scheduling.com (see src/lib/cookies.js) so a session set on either host
// is honored on both. APP_URL still points at www so magic-link emails land there
// by default.

import { handleApi } from "./src/api/router.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
