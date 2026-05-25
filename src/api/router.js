// URL-pattern dispatch. Tiny, no dependencies. Each entry is [method, pattern, handler].
// Patterns support :param segments which are extracted into the third arg.

import { authRequest, authVerify, authPassword, authLogout, me, verifyEmailChange } from "./auth.js";
import { authSignup } from "./signup.js";
import { createGroup, createInvite, getInvite, migrateGroup } from "./groups.js";
import { createUser } from "./users.js";
import { listOwnerUsers, updateOwnerUser, deleteOwnerUser, listSnapshotHistory, restoreSnapshot } from "./owner.js";
import { updateMyProfile, updateMyPassword, requestEmailChange } from "./profile.js";
import { forgotPassword, showResetPage, applyResetPassword } from "./reset.js";
import { logEvent, listEvents } from "./events.js";
import { putSnapshot, getLatestSnapshot } from "./snapshots.js";
import { err } from "../lib/http.js";

const routes = [
  ["POST",   "/api/auth/request",                 authRequest],
  ["GET",    "/api/auth/verify",                  authVerify],
  ["GET",    "/api/auth/verify-email-change",     verifyEmailChange],
  ["POST",   "/api/auth/password",                authPassword],
  ["POST",   "/api/auth/signup",                  authSignup],
  ["POST",   "/api/auth/logout",                  authLogout],
  ["POST",   "/api/auth/forgot-password",         forgotPassword],
  ["GET",    "/api/auth/reset-password",          showResetPage],
  ["POST",   "/api/auth/reset-password",          applyResetPassword],
  ["GET",    "/api/me",                           me],
  ["PATCH",  "/api/me/profile",                   updateMyProfile],
  ["POST",   "/api/me/password",                  updateMyPassword],
  ["POST",   "/api/me/change-email-request",      requestEmailChange],
  ["POST",   "/api/groups",                       createGroup],
  ["POST",   "/api/groups/:gid/invites",          createInvite],
  ["POST",   "/api/groups/:gid/migrate",          migrateGroup],
  ["GET",    "/api/invites/:token",               getInvite],
  ["POST",   "/api/users",                        createUser],
  ["GET",    "/api/owner/users",                  listOwnerUsers],
  ["PATCH",  "/api/owner/users/:uid",             updateOwnerUser],
  ["DELETE", "/api/owner/users/:uid",             deleteOwnerUser],
  ["POST",   "/api/events",                       logEvent],
  ["GET",    "/api/events",                       listEvents],
  ["POST",   "/api/snapshots",                    putSnapshot],
  ["GET",    "/api/snapshots/:groupId/latest",    getLatestSnapshot],
  ["GET",    "/api/owner/snapshots/:gid/r2-list", listSnapshotHistory],
  ["POST",   "/api/owner/snapshots/:gid/restore", restoreSnapshot],
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
