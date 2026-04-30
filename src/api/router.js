// URL-pattern dispatch. Tiny, no dependencies. Each entry is [method, pattern, handler].
// Patterns support :param segments which are extracted into the third arg.

import { authRequest, authVerify, authPassword, authLogout, me } from "./auth.js";
import { createGroup, createInvite, getInvite, migrateGroup } from "./groups.js";
import { createUser } from "./users.js";
import { logEvent } from "./events.js";
import { putSnapshot, getLatestSnapshot } from "./snapshots.js";
import { err } from "../lib/http.js";

const routes = [
  ["POST", "/api/auth/request",                   authRequest],
  ["GET",  "/api/auth/verify",                    authVerify],
  ["POST", "/api/auth/password",                  authPassword],
  ["POST", "/api/auth/logout",                    authLogout],
  ["GET",  "/api/me",                             me],
  ["POST", "/api/groups",                         createGroup],
  ["POST", "/api/groups/:gid/invites",            createInvite],
  ["POST", "/api/groups/:gid/migrate",            migrateGroup],
  ["GET",  "/api/invites/:token",                 getInvite],
  ["POST", "/api/users",                          createUser],
  ["POST", "/api/events",                         logEvent],
  ["POST", "/api/snapshots",                      putSnapshot],
  ["GET",  "/api/snapshots/:groupId/latest",      getLatestSnapshot],
];

export async function handleApi(req, env) {
  const url = new URL(req.url);
  const pathname = url.pathname;
  for (const [method, pattern, handler] of routes) {
    if (method !== req.method) continue;
    const params = match(pattern, pathname);
    if (params) {
      try {
        return await handler(req, env, params);
      } catch (e) {
        console.error(`api ${method} ${pathname} failed:`, e?.stack || e);
        return err(500, "server_error");
      }
    }
  }
  return err(404, "not_found");
}

function match(pattern, pathname) {
  const ps = pattern.split("/");
  const xs = pathname.split("/");
  if (ps.length !== xs.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return null;
  }
  return params;
}
