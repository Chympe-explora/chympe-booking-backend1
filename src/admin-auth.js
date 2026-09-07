/**
 * admin-auth.js — account system for the web dashboards. Three ways in
 * per role, all producing the same kind of session:
 *
 *   ADMIN
 *   - Legacy master password (env.ADMIN_PASSWORD) — unchanged, kept as
 *     a break-glass fallback that always works even before any admin
 *     account exists.
 *   - Real accounts: sign up (gated by env.ADMIN_SIGNUP_CODE, a secret
 *     you set once and only share with people who should get an admin
 *     account), verify the phone/email with an OTP, then log in with
 *     username + password from then on. Forgot password -> OTP -> set
 *     a new one.
 *
 *   GUIDE
 *   - Admin-invited one-time code (unchanged, see guides.js).
 *   - No-code "request to join" (unchanged, see guides.js) — status
 *     stays "pending" until approved either way.
 *   - Real accounts: sign up with name/phone-or-email/password (still
 *     lands as "pending" until an admin approves), log in with
 *     phone/email + password afterwards, forgot password -> OTP -> set
 *     a new one.
 *
 * Sessions live only in KV — `websession:<token>` for admins,
 * `guidesession:<token>` for guides (guides.js owns that half) — same
 * as before, so nothing about how routes check `authenticate()`
 * changes.
 */

import { json } from "./booking.js";
import {
  getGuideByWebToken,
  redeemGuideCodeWeb,
  requestToJoinAsGuide,
  findGuideByLoginIdentifier,
  signupGuideAccount,
  setGuidePasswordHash,
  linkGuideLoginIdentifier,
  loginGuideWithPassword,
} from "./guides.js";
import { sendOtp, verifyOtp } from "./otp.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./pwhash.js";

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------
// Admin account storage — KV `adminuser:<username>` -> JSON record.
// ---------------------------------------------------------------------
function adminKey(username) {
  return `adminuser:${String(username).trim().toLowerCase()}`;
}
async function getAdminAccount(env, username) {
  const raw = await env.BOOKINGS.get(adminKey(username));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function saveAdminAccount(env, account) {
  await env.BOOKINGS.put(adminKey(account.username), JSON.stringify(account));
}

// ---- ADMIN: legacy master-password login, plus real account login ----
export async function handleAdminLogin(request, env) {
  const { password, username } = await request.json().catch(() => ({}));

  // Real account login, if a username was given.
  if (username) {
    const account = await getAdminAccount(env, username);
    if (!account) return json({ ok: false, error: "No admin account with that username." }, env, 401);
    if (!account.verified) return json({ ok: false, error: "This account hasn't verified its phone/email yet." }, env, 401);
    const valid = await verifyPassword(password || "", account.passwordHash);
    if (!valid) return json({ ok: false, error: "Wrong password." }, env, 401);
    const token = randomToken();
    await env.BOOKINGS.put(`websession:${token}`, JSON.stringify({ username: account.username }), { expirationTtl: SESSION_TTL });
    return json({ ok: true, token, role: "admin", username: account.username }, env);
  }

  // Legacy master password (no username given) — still works as a
  // break-glass login even with zero admin accounts created.
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "ADMIN_PASSWORD is not configured on this Worker yet — see SETUP_INSTRUCTIONS.md." }, env, 500);
  }
  if (!password || password !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "Wrong password." }, env, 401);
  }
  const token = randomToken();
  await env.BOOKINGS.put(`websession:${token}`, "admin", { expirationTtl: SESSION_TTL });
  return json({ ok: true, token, role: "admin" }, env);
}

// ---- ADMIN: sign up ----
// Step 1: POST { username, password, phone?, email?, signupCode } ->
// creates an UNVERIFIED account and sends an OTP to phone/email.
export async function handleAdminSignup(request, env) {
  const { username, password, phone, email, signupCode } = await request.json().catch(() => ({}));

  if (!env.ADMIN_SIGNUP_CODE) {
    return json({ ok: false, error: "Admin sign-up is not enabled on this Worker yet — set ADMIN_SIGNUP_CODE as a secret first (see SETUP_INSTRUCTIONS.md)." }, env, 500);
  }
  if (!signupCode || signupCode !== env.ADMIN_SIGNUP_CODE) {
    return json({ ok: false, error: "Invalid sign-up code." }, env, 403);
  }
  if (!username || String(username).trim().length < 3) return json({ ok: false, error: "Choose a username (3+ characters)." }, env, 400);
  const pwError = validatePasswordStrength(password);
  if (pwError) return json({ ok: false, error: pwError }, env, 400);
  if (!phone && !email) return json({ ok: false, error: "A phone number or email is required, to verify the account and for password resets." }, env, 400);

  const existing = await getAdminAccount(env, username);
  if (existing) return json({ ok: false, error: "That username is already taken." }, env, 409);

  const passwordHash = await hashPassword(password);
  const account = {
    username: String(username).trim(),
    passwordHash,
    phone: phone ? String(phone).trim() : null,
    email: email ? String(email).trim().toLowerCase() : null,
    verified: false,
    createdAt: Date.now(),
  };
  await saveAdminAccount(env, account);

  const sent = await sendOtp(env, {
    purpose: "admin-signup",
    identifier: username,
    phone: account.phone,
    email: account.email,
    label: `New admin sign-up: ${account.username}`,
  });
  if (!sent.ok) return json({ ok: false, error: sent.error }, env, 502);
  return json({ ok: true, needsVerification: true, channel: sent.channel }, env);
}

// Step 2: POST { username, code } -> verifies the account, logs them in.
export async function handleAdminVerifySignup(request, env) {
  const { username, code } = await request.json().catch(() => ({}));
  if (!username || !code) return json({ ok: false, error: "username and code are required." }, env, 400);

  const account = await getAdminAccount(env, username);
  if (!account) return json({ ok: false, error: "No such pending account." }, env, 404);

  const result = await verifyOtp(env, { purpose: "admin-signup", identifier: username, code });
  if (!result.ok) return json({ ok: false, error: result.error }, env, 401);

  account.verified = true;
  await saveAdminAccount(env, account);
  const token = randomToken();
  await env.BOOKINGS.put(`websession:${token}`, JSON.stringify({ username: account.username }), { expirationTtl: SESSION_TTL });
  return json({ ok: true, token, role: "admin", username: account.username }, env);
}

// ---- ADMIN: forgot / reset password ----
export async function handleAdminForgotPassword(request, env) {
  const { username, channel } = await request.json().catch(() => ({}));
  if (!username) return json({ ok: false, error: "username is required." }, env, 400);
  const account = await getAdminAccount(env, username);
  // Don't reveal whether the username exists.
  if (!account) return json({ ok: true, sent: true }, env);

  const sent = await sendOtp(env, {
    purpose: "admin-reset",
    identifier: username,
    phone: account.phone,
    email: account.email,
    channel: channel || "auto",
    label: `Password reset requested for admin: ${account.username}`,
  });
  return json({ ok: true, sent: sent.ok, channel: sent.channel }, env);
}

export async function handleAdminResetPassword(request, env) {
  const { username, code, newPassword } = await request.json().catch(() => ({}));
  if (!username || !code || !newPassword) return json({ ok: false, error: "username, code and newPassword are required." }, env, 400);
  const pwError = validatePasswordStrength(newPassword);
  if (pwError) return json({ ok: false, error: pwError }, env, 400);

  const account = await getAdminAccount(env, username);
  if (!account) return json({ ok: false, error: "No such account." }, env, 404);

  const result = await verifyOtp(env, { purpose: "admin-reset", identifier: username, code });
  if (!result.ok) return json({ ok: false, error: result.error }, env, 401);

  account.passwordHash = await hashPassword(newPassword);
  account.verified = true;
  await saveAdminAccount(env, account);
  return json({ ok: true }, env);
}

// ---- GUIDE: code login, plus password login ----
export async function handleGuideLogin(request, env) {
  const { code, identifier, password } = await request.json().catch(() => ({}));

  // Password login, if an identifier (phone/email) was given.
  if (identifier) {
    const result = await loginGuideWithPassword(env, identifier, (hash) => verifyPassword(password || "", hash));
    if (result.error) return json({ ok: false, error: result.error }, env, 401);
    return json({ ok: true, token: result.token, role: "guide", guide: publicGuide(result.guide) }, env);
  }

  if (!code) return json({ ok: false, error: "Enter your access code, or log in with phone/email + password." }, env, 400);
  const result = await redeemGuideCodeWeb(env, code);
  if (!result) {
    return json({ ok: false, error: "That code is invalid, already used, or expired. Ask the admin for a new one." }, env, 401);
  }
  return json({ ok: true, token: result.token, role: "guide", guide: publicGuide(result.guide) }, env);
}

// A guide who wasn't invited by the admin yet — no code needed. This
// logs them in immediately (status: "pending"), so their browser stays
// signed in the moment an admin approves them; until then, the
// dashboard just shows a waiting screen (see publicGuide's `status`).
export async function handleGuideJoinRequest(request, env) {
  const { name, phone, site, services } = await request.json().catch(() => ({}));
  if (!name || !String(name).trim()) return json({ ok: false, error: "Your name is required." }, env, 400);
  if (!site) return json({ ok: false, error: "Pick which site you'll be guiding for." }, env, 400);

  const { guide, token } = await requestToJoinAsGuide(env, { name, phone, site, services });
  return json({ ok: true, token, role: "guide", guide: publicGuide(guide) }, env);
}

// ---- GUIDE: password sign up (new account, still lands as pending) ----
export async function handleGuideSignup(request, env) {
  const { name, phone, email, site, services, password } = await request.json().catch(() => ({}));
  if (!name || !String(name).trim()) return json({ ok: false, error: "Your name is required." }, env, 400);
  if (!phone && !email) return json({ ok: false, error: "A phone number or email is required." }, env, 400);
  const pwError = validatePasswordStrength(password);
  if (pwError) return json({ ok: false, error: pwError }, env, 400);

  const passwordHash = await hashPassword(password);
  const result = await signupGuideAccount(env, { name, phone, email, site, services, passwordHash });
  if (result.error) return json({ ok: false, error: result.error }, env, 409);

  // Verify the contact right away with an OTP, same idea as admin signup.
  const sent = await sendOtp(env, {
    purpose: "guide-signup",
    identifier: result.guide.id,
    phone: result.guide.phone,
    email: result.guide.email,
    label: `New guide sign-up: ${result.guide.name}`,
  });

  return json({ ok: true, token: result.token, role: "guide", guide: publicGuide(result.guide), otpSent: sent.ok, channel: sent.channel }, env);
}

// Guide confirms the OTP sent at signup. Purely a "yes this phone/email
// is really yours" check — approval to actually take bookings is still
// a separate admin step (see guides.js#approveGuide).
export async function handleGuideVerifySignup(request, env) {
  const { guideId, code } = await request.json().catch(() => ({}));
  if (!guideId || !code) return json({ ok: false, error: "guideId and code are required." }, env, 400);
  const result = await verifyOtp(env, { purpose: "guide-signup", identifier: guideId, code });
  if (!result.ok) return json({ ok: false, error: result.error }, env, 401);
  return json({ ok: true }, env);
}

// ---- GUIDE: forgot / reset password ----
export async function handleGuideForgotPassword(request, env) {
  const { identifier, channel } = await request.json().catch(() => ({}));
  if (!identifier) return json({ ok: false, error: "Enter the phone/email on your account." }, env, 400);
  const guide = await findGuideByLoginIdentifier(env, identifier);
  if (!guide) return json({ ok: true, sent: true }, env); // don't reveal existence

  const sent = await sendOtp(env, {
    purpose: "guide-reset",
    identifier: guide.id,
    phone: guide.phone,
    email: guide.email,
    channel: channel || "auto",
    label: `Password reset requested for guide: ${guide.name}`,
  });
  return json({ ok: true, sent: sent.ok, channel: sent.channel }, env);
}

export async function handleGuideResetPassword(request, env) {
  const { identifier, code, newPassword } = await request.json().catch(() => ({}));
  if (!identifier || !code || !newPassword) return json({ ok: false, error: "identifier, code and newPassword are required." }, env, 400);
  const pwError = validatePasswordStrength(newPassword);
  if (pwError) return json({ ok: false, error: pwError }, env, 400);

  const guide = await findGuideByLoginIdentifier(env, identifier);
  if (!guide) return json({ ok: false, error: "No account found for that phone/email." }, env, 404);

  const result = await verifyOtp(env, { purpose: "guide-reset", identifier: guide.id, code });
  if (!result.ok) return json({ ok: false, error: result.error }, env, 401);

  const passwordHash = await hashPassword(newPassword);
  await setGuidePasswordHash(env, guide.id, passwordHash);
  await linkGuideLoginIdentifier(env, guide.id, identifier);
  return json({ ok: true }, env);
}

// ---------------------------------------------------------------------
export async function handleLogout(request, env, auth) {
  if (auth?.role === "admin" && auth.token) await env.BOOKINGS.delete(`websession:${auth.token}`);
  if (auth?.role === "guide" && auth.token) await env.BOOKINGS.delete(`guidesession:${auth.token}`);
  return json({ ok: true }, env);
}

export function publicGuide(g) {
  if (!g) return null;
  return {
    id: g.id,
    name: g.name,
    site: g.site,
    services: g.services,
    status: g.status || "approved",
    active: g.active,
    bookingAccess: g.bookingAccess,
    phone: g.phone || null,
    email: g.email || null,
  };
}

// Reads "Authorization: Bearer <token>", resolves it to { role, token, guide? }.
// Returns null if missing/invalid — caller responds 401.
export async function authenticate(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) return null;

  const adminFlag = await env.BOOKINGS.get(`websession:${token}`);
  if (adminFlag) {
    if (adminFlag === "admin") return { role: "admin", token };
    try {
      const parsed = JSON.parse(adminFlag);
      return { role: "admin", token, username: parsed.username };
    } catch {
      return { role: "admin", token };
    }
  }

  const guide = await getGuideByWebToken(env, token);
  if (guide) return { role: "guide", token, guide };

  return null;
}

export function requireAdmin(auth, env) {
  if (!auth || auth.role !== "admin") return json({ ok: false, error: "Not authorized." }, env, 401);
  return null;
}

export function requireGuide(auth, env) {
  if (!auth || auth.role !== "guide") return json({ ok: false, error: "Not authorized." }, env, 401);
  return null;
}
