// Single Worker that fronts the Cloudflare static-assets binding.
// /api/* → API handler. Everything else falls through to the assets binding,
// which serves index.html / shyft-v3.html / etc. exactly as before.

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
