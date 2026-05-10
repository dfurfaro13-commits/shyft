// URL-pattern dispatch. Tiny, no dependencies. Each entry is [method, pattern, handler].
// Patterns support :param segments which are extracted into the third arg.

import { authRequest, authVerify, authPassword, authLogout, me, updateMe } from "./auth.js";
import { authSignup } from "./signup.js";
import { createGroup, createInvite, getInvite, migrateGroup, updateGroupCodes } from "./groups.js";
import { createUser } from "./users.js";
import { listOwnerUsers, updateOwnerUser, deleteOwnerUser, lookupUser } from "./owner.js";
import { logEvent } from "./events.js";
import { putSnapshot, getLatestSnapshot, listSnapshotHistory, restoreSnapshot } from "./snapshots.js";
import { err } from "../lib/http.js";

const routes = [
  ["POST",   "/api/auth/request",                 authRequest],
  ["GET",    "/api/auth/verify",                  authVerify],
  ["POST",   "/api/auth/password",                authPassword],
  ["POST",   "/api/auth/signup",                  authSignup],
  ["POST",   "/api/auth/logout",                  authLogout],
  ["GET",    "/api/me",                           me],
  ["PATCH",  "/api/me",                           updateMe],
  ["POST",   "/api/groups",                       createGroup],
  ["POST",   "/api/groups/:gid/invites",          createInvite],
  ["POST",   "/api/groups/:gid/migrate",          migrateGroup],
  ["PATCH",  "/api/groups/:gid/codes",            updateGroupCodes],
  ["GET",    "/api/invites/:token",               getInvite],
  ["POST",   "/api/users",                        createUser],
  ["GET",    "/api/owner/users",                  listOwnerUsers],
  ["GET",    "/api/owner/lookup",                 lookupUser],
  ["PATCH",  "/api/owner/users/:uid",             updateOwnerUser],
  ["DELETE", "/api/owner/users/:uid",             deleteOwnerUser],
  ["POST",   "/api/events",                       logEvent],
  ["POST",   "/api/snapshots",                    putSnapshot],
  ["GET",    "/api/snapshots/:groupId/latest",    getLatestSnapshot],
  ["GET",    "/api/owner/snapshots/:groupId/history",  listSnapshotHistory],
  ["POST",   "/api/owner/snapshots/:groupId/restore",  restoreSnapshot],
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
