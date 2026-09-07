/**
 * guides.js — Guide Management + package-based random booking
 * assignment, and the guide's own Telegram dashboard.
 *
 * Data model (plain KV, NOT the saveDoc/getDoc "permanent Telegram log"
 * pattern used for content/prices/etc — this data churns far too often
 * for that; every booking assignment or Active toggle would spam the
 * admin chat with a JSON dump otherwise):
 *
 *   guides:list          -> array of guide records (see shape below)
 *   guidecode:<code>     -> guideId (one-time-use, 7-day TTL)
 *   guideBookings:<id>   -> array of bookingIds assigned to that guide,
 *                           most-recent-last, capped to the last 300
 *
 * Guide record:
 *   {
 *     id,             // short internal id, e.g. "G1" — NOT their chat id
 *     name,           // display name (admin-given, or self-entered on request)
 *     phone,          // optional contact, self-entered on a join request
 *     site,           // "krem-chympe" | "wilderness-expedition"
 *     services,       // array of package keys, or ["all"]
 *     status,         // "pending" | "approved" — see JOIN REQUESTS below
 *     active,         // bool — the guide's own 🟢/🔴 toggle
 *     bookingAccess,  // bool — admin-only hard lock (🚫 Remove Booking
 *                     // Access); false overrides `active` either way
 *     chatId,         // null until their code is redeemed
 *     code,           // the still-pending access code, cleared on redemption
 *     webLinked,      // bool — true once linked to a web session (see below)
 *     createdAt, linkedAt, approvedAt
 *   }
 *
 * A guide is only eligible for a NEW booking when status === "approved"
 * && active && bookingAccess && (chatId set OR webLinked) &&
 * (services includes "all" or the booking's package key).
 *
 * ---------------------------------------------------------------------
 * TWO WAYS A GUIDE GETS LINKED:
 *
 * 1. Admin-invited (original flow) — admin taps "➕ Add Guide" (or the
 *    web equivalent), a 6-character one-time code is generated, the
 *    guide redeems it (via Telegram or the web login page) and is
 *    linked + approved immediately, since the admin already vouched
 *    for them by creating the record.
 *
 * 2. Self-requested (new) — ANYONE can open the guide login page and
 *    tap "Request to join" with their name/phone/site — no code
 *    needed. This creates a guide record with status: "pending" and
 *    logs them into the web dashboard right away, but the dashboard
 *    just shows "waiting for admin approval" until the admin taps
 *    ✅ Approve on the pending request. Nothing about them (site,
 *    services) makes them eligible for bookings until approved.
 * ---------------------------------------------------------------------
 */

// Every site with an actual booking backend has these two packages
// today (see content-schema.js's `packages` block for each site) — kept
// as a small constant here rather than re-deriving it from the pricing
// doc on every call, since adding a genuinely new package is a code
// change anyway (new pricing rules, new form fields), not something
// this list needs to stay dynamically in sync with.
export const SITE_PACKAGES = {
  "krem-chympe": [
    { key: "sharedTour", label: "📦 Package 1 — Shared Tour" },
    { key: "privatePackage", label: "🧭 Private Tour" },
  ],
  "wilderness-expedition": [
    { key: "sharedTour", label: "📦 Package 1 — Shared Tour" },
    { key: "privatePackage", label: "🧭 Private Tour" },
  ],
};
export const GUIDE_SITES = Object.keys(SITE_PACKAGES);

export async function getGuides(env) {
  const raw = await env.BOOKINGS.get("guides:list");
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
export async function saveGuides(env, guides) {
  await env.BOOKINGS.put("guides:list", JSON.stringify(guides));
}
export async function getGuide(env, guideId) {
  const guides = await getGuides(env);
  return guides.find((g) => g.id === guideId) || null;
}
export async function getGuideByChatId(env, chatId) {
  const guides = await getGuides(env);
  return guides.find((g) => String(g.chatId) === String(chatId)) || null;
}
export async function isLinkedGuide(env, chatId) {
  return !!(await getGuideByChatId(env, chatId));
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read aloud
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function nextGuideId(env) {
  const n = (parseInt((await env.BOOKINGS.get("guides:counter")) || "0", 10) || 0) + 1;
  await env.BOOKINGS.put("guides:counter", String(n));
  return `G${n}`;
}

// Creates a new (not-yet-linked) guide record and a fresh code for it.
// Returns { guide, code }.
export async function createGuide(env, { name, site, services }) {
  const guides = await getGuides(env);
  const id = await nextGuideId(env);
  const code = randomCode();
  const guide = {
    id,
    name: name || `Guide ${id}`,
    site,
    services: services && services.length ? services : ["all"],
    status: "approved", // admin created this record directly — already vouched for
    active: true,
    bookingAccess: true,
    chatId: null,
    code,
    webLinked: false,
    createdAt: Date.now(),
    linkedAt: null,
  };
  guides.push(guide);
  await saveGuides(env, guides);
  await env.BOOKINGS.put(`guidecode:${code}`, id, { expirationTtl: 60 * 60 * 24 * 7 });
  return { guide, code };
}

// Regenerates the code for an existing guide (e.g. they lost it, or
// admin wants to re-link them to a different Telegram account).
export async function regenerateGuideCode(env, guideId) {
  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  const code = randomCode();
  guide.code = code;
  await saveGuides(env, guides);
  await env.BOOKINGS.put(`guidecode:${code}`, guideId, { expirationTtl: 60 * 60 * 24 * 7 });
  return code;
}

// Called when someone pastes a code into the bot. Links their chat id to
// the guide record that code belongs to. Returns the linked guide, or
// null if the code isn't valid/pending.
export async function redeemGuideCode(env, code, chatId) {
  const key = `guidecode:${code}`;
  const guideId = await env.BOOKINGS.get(key);
  if (!guideId) return null;
  await env.BOOKINGS.delete(key);

  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.chatId = String(chatId);
  guide.code = null;
  guide.linkedAt = Date.now();
  await saveGuides(env, guides);
  return guide;
}

// ---------------------------------------------------------------------
// WEB LOGIN — the same one-time access code (from "➕ Add Guide" /
// "🔁 Regenerate Code") also works as a guide's web login, since the
// admin web dashboard now covers everything Telegram used to (Telegram
// is just the storage layer underneath both). Redeeming via web sets
// `webLinked` instead of `chatId` — a guide can be linked to Telegram,
// the web, or both; either is enough to make them eligible for
// bookings (see pickGuideForBooking below). A long-lived session token
// is minted so the guide's browser stays logged in, the same way their
// Telegram chat id stays "logged in" forever once linked.
// ---------------------------------------------------------------------
const WEB_SESSION_TTL = 60 * 60 * 24 * 180; // 180 days

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function redeemGuideCodeWeb(env, code) {
  const raw = String(code || "").trim().toUpperCase();
  const key = `guidecode:${raw}`;
  const guideId = await env.BOOKINGS.get(key);
  if (!guideId) return null;
  await env.BOOKINGS.delete(key);

  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.webLinked = true;
  guide.code = null;
  guide.linkedAt = guide.linkedAt || Date.now();
  await saveGuides(env, guides);

  const token = randomToken();
  await env.BOOKINGS.put(`guidesession:${token}`, guideId, { expirationTtl: WEB_SESSION_TTL });
  return { guide, token };
}

export async function getGuideByWebToken(env, token) {
  if (!token) return null;
  const guideId = await env.BOOKINGS.get(`guidesession:${token}`);
  if (!guideId) return null;
  return getGuide(env, guideId);
}

export async function revokeGuideWebToken(env, token) {
  if (!token) return;
  await env.BOOKINGS.delete(`guidesession:${token}`);
}

// ---------------------------------------------------------------------
// JOIN REQUESTS — anyone can request to become a guide straight from
// the web login page, no admin-generated code needed. They're logged
// into the web dashboard the moment they submit (see the returned
// token), but with status: "pending" — the dashboard shows a
// "waiting for approval" screen and none of the guide actions work
// until an admin approves them. This is the low-friction counterpart
// to the admin-invites-first flow above; both end up as normal,
// fully-functional guide records once approved.
// ---------------------------------------------------------------------
export async function requestToJoinAsGuide(env, { name, phone, site, services }) {
  const guides = await getGuides(env);
  const id = await nextGuideId(env);
  const guide = {
    id,
    name: (name || `Guide ${id}`).trim(),
    phone: phone ? String(phone).trim() : null,
    site: GUIDE_SITES.includes(site) ? site : GUIDE_SITES[0],
    services: services && services.length ? services : ["all"],
    status: "pending", // ⏳ needs an admin's ✅ Approve before this guide can do anything
    active: false,
    bookingAccess: false,
    chatId: null,
    code: null,
    webLinked: true, // logged in immediately — see the token minted below
    createdAt: Date.now(),
    linkedAt: Date.now(),
  };
  guides.push(guide);
  await saveGuides(env, guides);

  const token = randomToken();
  await env.BOOKINGS.put(`guidesession:${token}`, id, { expirationTtl: WEB_SESSION_TTL });
  return { guide, token };
}

export async function listPendingGuides(env) {
  const guides = await getGuides(env);
  return guides.filter((g) => g.status === "pending");
}

// Admin taps ✅ Approve on a pending request — flips it into a normal,
// fully eligible guide in one step (no separate "now also turn Active
// on" step needed).
export async function approveGuide(env, guideId) {
  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.status = "approved";
  guide.active = true;
  guide.bookingAccess = true;
  guide.approvedAt = Date.now();
  await saveGuides(env, guides);
  return guide;
}

// Admin taps ❌ Reject — the request is simply removed (same as
// removeGuide below); their web session, if any, stops resolving to a
// guide record on its very next request.
export async function rejectGuide(env, guideId) {
  return removeGuide(env, guideId);
}

export async function setGuideActive(env, guideId, active) {
  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.active = active;
  await saveGuides(env, guides);
  return guide;
}
export async function setGuideBookingAccess(env, guideId, allowed) {
  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.bookingAccess = allowed;
  await saveGuides(env, guides);
  return guide;
}
export async function removeGuide(env, guideId) {
  const guides = await getGuides(env);
  const next = guides.filter((g) => g.id !== guideId);
  await saveGuides(env, next);
  // Existing bookings already assigned to this guide are untouched —
  // only removes them from future random assignment.
}

// ---------------------------------------------------------------------
// ASSIGNMENT — called from booking.js's handleSubmit.
// ---------------------------------------------------------------------

// Picks ONE eligible active guide at random for this site+package, or
// null if none exist (caller falls back to the admin group as the
// actionable recipient in that case).
export async function pickGuideForBooking(env, site, packageKey) {
  const guides = await getGuides(env);
  const eligible = guides.filter(
    (g) =>
      g.site === site &&
      g.status !== "pending" && // pending join requests are never auto-assigned bookings; legacy records with no status field at all are treated as already-approved
      (g.chatId || g.webLinked) && // code must actually be redeemed, via Telegram or the web dashboard
      g.active &&
      g.bookingAccess !== false &&
      (!packageKey || g.services.includes("all") || g.services.includes(packageKey))
  );
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

// Records the assignment (for the guide's dashboard) and appends to
// their booking index. Capped so one very active guide's index can't
// grow forever.
export async function assignBookingToGuide(env, guideId, bookingId) {
  const key = `guideBookings:${guideId}`;
  const raw = await env.BOOKINGS.get(key);
  let list = [];
  if (raw) {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  list.push(bookingId);
  if (list.length > 300) list = list.slice(-300);
  await env.BOOKINGS.put(key, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 120 });
}

export async function getGuideBookingIds(env, guideId) {
  const raw = await env.BOOKINGS.get(`guideBookings:${guideId}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// PASSWORD ACCOUNTS — a third way to become/log in as a guide, on top
// of admin-invited codes and no-code join-requests: a guide can also
// sign up themselves with a phone/email + password, same as the admin
// dashboard's account system. This still creates a normal guide record
// with status "pending" (see requestToJoinAsGuide above) — an admin
// still has to approve them before they're eligible for bookings —
// it's just a different, password-based way in instead of a magic
// link/code, so the same account works for every future login too.
//
// A phone or email is required and stored lowercase/trimmed as the
// lookup key: `guidelogin:<phone-or-email>` -> guideId.
// ---------------------------------------------------------------------

function loginKey(identifier) {
  return `guidelogin:${String(identifier).trim().toLowerCase()}`;
}

export async function findGuideByLoginIdentifier(env, identifier) {
  if (!identifier) return null;
  const guideId = await env.BOOKINGS.get(loginKey(identifier));
  if (!guideId) return null;
  return getGuide(env, guideId);
}

// Creates a new guide account with a password. Returns { guide, token }
// (already logged in, same shape as requestToJoinAsGuide) or
// { error } if the phone/email is already registered.
export async function signupGuideAccount(env, { name, phone, email, site, services, passwordHash }) {
  const identifier = phone || email;
  if (!identifier) return { error: "A phone number or email is required." };
  const existing = await findGuideByLoginIdentifier(env, identifier);
  if (existing) return { error: "An account with that phone/email already exists. Try logging in instead." };

  const guides = await getGuides(env);
  const id = await nextGuideId(env);
  const guide = {
    id,
    name: (name || `Guide ${id}`).trim(),
    phone: phone ? String(phone).trim() : null,
    email: email ? String(email).trim().toLowerCase() : null,
    site: GUIDE_SITES.includes(site) ? site : GUIDE_SITES[0],
    services: services && services.length ? services : ["all"],
    status: "pending", // needs admin approval, same as a no-code join request
    active: false,
    bookingAccess: false,
    chatId: null,
    code: null,
    webLinked: true,
    passwordHash,
    createdAt: Date.now(),
    linkedAt: Date.now(),
  };
  guides.push(guide);
  await saveGuides(env, guides);
  await env.BOOKINGS.put(loginKey(identifier), id);

  const token = randomToken();
  await env.BOOKINGS.put(`guidesession:${token}`, id, { expirationTtl: WEB_SESSION_TTL });
  return { guide, token };
}

export async function setGuidePasswordHash(env, guideId, passwordHash) {
  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.passwordHash = passwordHash;
  await saveGuides(env, guides);
  return guide;
}

// Makes sure a guide created via the old admin-invite or no-code
// join-request flow can also be found by phone/email once they add
// one (e.g. from Account settings), so password login/reset works for
// every guide, not just ones who signed themselves up.
export async function linkGuideLoginIdentifier(env, guideId, identifier) {
  if (!identifier) return;
  await env.BOOKINGS.put(loginKey(identifier), guideId);
}

export async function loginGuideWithPassword(env, identifier, verifyFn) {
  const guide = await findGuideByLoginIdentifier(env, identifier);
  if (!guide || !guide.passwordHash) return { error: "No account found for that phone/email." };
  const valid = await verifyFn(guide.passwordHash);
  if (!valid) return { error: "Wrong password." };

  const token = randomToken();
  await env.BOOKINGS.put(`guidesession:${token}`, guide.id, { expirationTtl: WEB_SESSION_TTL });
  return { guide, token };
}
