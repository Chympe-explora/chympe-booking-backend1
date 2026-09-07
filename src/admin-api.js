/**
 * admin-api.js — every button the Telegram admin bot has, as an HTTP
 * endpoint the web dashboard calls instead. Nothing here duplicates
 * storage logic — it's a thin HTTP layer over the exact same modules
 * telegram-bot.js already uses (store.js, guides.js, payments.js,
 * era-ai.js, conversations.js, stats.js, ratings.js, pricing.js,
 * booking.js). Telegram remains the permanent record; this is just a
 * second front door to it, guarded by admin-auth.js instead of
 * ADMIN_USER_IDS.
 *
 * Generic content editing (site text / prices / highlights / images /
 * videos / discounts) is exposed as a JSON-tree API — GET the merged
 * doc, POST a value at a dotted path, or DELETE a path back to
 * default — mirroring walker.js's "any JSON object is navigable"
 * design instead of one hand-written endpoint per field. Background,
 * Sections, Hero Button and Fonts & Colors are all just paths inside
 * the `content:<site>` tree (see telegram-bot.js's bgpick/secpick/
 * herobtnpick/fontpick shortcuts) — the web dashboard jumps straight
 * to those paths instead of re-implementing them separately.
 */

import { json } from "./booking.js";
import {
  authenticate,
  requireAdmin,
  requireGuide,
  handleAdminLogin,
  handleAdminSignup,
  handleAdminVerifySignup,
  handleAdminForgotPassword,
  handleAdminResetPassword,
  handleGuideLogin,
  handleGuideJoinRequest,
  handleGuideSignup,
  handleGuideVerifySignup,
  handleGuideForgotPassword,
  handleGuideResetPassword,
  handleLogout,
  publicGuide,
} from "./admin-auth.js";
import { SITES, SITE_LABELS, isValidSite, getDoc, saveDoc, deepMerge, setPathSeeded, deletePath } from "./store.js";
import { SCHEMA_DEFAULTS } from "./content-schema.js";
import { DEFAULT_DISCOUNTS } from "./pricing.js";
import {
  SITE_PACKAGES,
  GUIDE_SITES,
  getGuides,
  getGuide,
  createGuide,
  regenerateGuideCode,
  setGuideActive,
  setGuideBookingAccess,
  removeGuide,
  getGuideBookingIds,
  listPendingGuides,
  approveGuide,
  rejectGuide,
} from "./guides.js";
import { GATEWAYS, getPaymentConfig, savePaymentConfig, setCredentialField, getMaskedCredentials } from "./payments.js";
import {
  getEraStatusText,
  listUnanswered,
  teachAnswer,
  discardUnanswered,
  setLearningEnabled,
  parseQABlob,
  teachBulkAnswers,
  addAdminNotes,
  getAdminNotes,
} from "./era-ai.js";
import { listConversations, getConvLog, setConversationStatus, toggleConversationActive, toggleSessionBlocked, isSessionBlocked, pushOutbox, appendConvLog, statusLabel } from "./conversations.js";
import { getLiveStats, resetStats } from "./stats.js";
import { setBookingStatus } from "./booking.js";
import { tgSendPhotoBytes, tgSendVideoBytes } from "./telegram.js";

// ---- doc-kind <-> default-value plumbing (mirrors telegram-bot.js) ----
function defaultsFor(kind, site) {
  if (kind === "discounts") return DEFAULT_DISCOUNTS;
  if (kind === "highlights") return [];
  if (kind === "ratings") return [];
  const schema = SCHEMA_DEFAULTS[site];
  if (!schema) return {};
  if (kind === "content") return schema.KC_CONTENT || {};
  if (kind === "images") return schema.KC_IMAGES || {};
  if (kind === "prices") return schema.KC_PRICES || {};
  if (kind === "videos") return {};
  return {};
}
function docKeyFor(kind, site) {
  return kind === "discounts" ? "discounts:global" : `${kind}:${site}`;
}
function parseDocKey(key) {
  const [kind, site] = String(key || "").split(":");
  return { kind, site };
}
async function loadMerged(env, kind, site) {
  const docKey = docKeyFor(kind, site);
  const base = defaultsFor(kind, site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  return { docKey, base, override, merged: deepMerge(base, override) };
}

function bad(env, msg, status = 400) {
  return json({ ok: false, error: msg }, env, status);
}

// ---------------------------------------------------------------------
// MAIN DISPATCH — index.js hands off anything under /api/admin/* and
// /api/guide/* (except the two login routes, which need no auth) here.
// ---------------------------------------------------------------------
export async function handleAdminApiRequest(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/admin/login" && method === "POST") return handleAdminLogin(request, env);
  if (path === "/api/admin/signup" && method === "POST") return handleAdminSignup(request, env);
  if (path === "/api/admin/signup/verify" && method === "POST") return handleAdminVerifySignup(request, env);
  if (path === "/api/admin/forgot-password" && method === "POST") return handleAdminForgotPassword(request, env);
  if (path === "/api/admin/reset-password" && method === "POST") return handleAdminResetPassword(request, env);

  if (path === "/api/guide/login" && method === "POST") return handleGuideLogin(request, env);
  if (path === "/api/guide/request-join" && method === "POST") return handleGuideJoinRequest(request, env);
  if (path === "/api/guide/signup" && method === "POST") return handleGuideSignup(request, env);
  if (path === "/api/guide/signup/verify" && method === "POST") return handleGuideVerifySignup(request, env);
  if (path === "/api/guide/forgot-password" && method === "POST") return handleGuideForgotPassword(request, env);
  if (path === "/api/guide/reset-password" && method === "POST") return handleGuideResetPassword(request, env);

  const auth = await authenticate(request, env);

  if (path === "/api/logout" && method === "POST") return handleLogout(request, env, auth);
  if (path === "/api/me" && method === "GET") {
    if (!auth) return bad(env, "Not authorized.", 401);
    return json({ ok: true, role: auth.role, guide: auth.guide ? publicGuide(auth.guide) : undefined }, env);
  }

  if (path.startsWith("/api/guide/")) {
    const denied = requireGuide(auth, env);
    if (denied) return denied;
    return routeGuide(request, env, ctx, url, auth.guide);
  }

  if (path.startsWith("/api/admin/")) {
    const denied = requireAdmin(auth, env);
    if (denied) return denied;
    return routeAdmin(request, env, ctx, url);
  }

  return bad(env, "not found", 404);
}

// ---------------------------------------------------------------------
// ADMIN ROUTES
// ---------------------------------------------------------------------
async function routeAdmin(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const body = method === "POST" || method === "PUT" ? await request.json().catch(() => ({})) : null;

  // ---- sites list (for building the site picker in the UI) ----
  if (path === "/api/admin/sites" && method === "GET") {
    return json({ ok: true, sites: SITES.map((s) => ({ id: s, label: SITE_LABELS[s] || s })) }, env);
  }

  // ---- generic JSON-tree document editing ----
  // GET  /api/admin/doc?key=content:root
  if (path === "/api/admin/doc" && method === "GET") {
    const key = url.searchParams.get("key");
    const { kind, site } = parseDocKey(key);
    if (!kind) return bad(env, "key is required, e.g. content:root");
    if (site && !isValidSite(site)) return bad(env, "bad site");
    const { override, merged } = await loadMerged(env, kind, site);
    return json({ ok: true, key, merged, override }, env);
  }

  // POST /api/admin/doc/path  { key, path, value }
  if (path === "/api/admin/doc/path" && method === "POST") {
    const { key, path: fieldPath, value } = body || {};
    const { kind, site } = parseDocKey(key);
    if (!kind || !fieldPath) return bad(env, "key and path are required");
    const { docKey, override, merged } = await loadMerged(env, kind, site);
    setPathSeeded(override, merged, fieldPath, value);
    await saveDoc(env, docKey, override, { logChange: `Web admin edited ${fieldPath}` });
    return json({ ok: true }, env);
  }

  // POST /api/admin/doc/reset-path  { key, path }
  if (path === "/api/admin/doc/reset-path" && method === "POST") {
    const { key, path: fieldPath } = body || {};
    const { kind, site } = parseDocKey(key);
    if (!kind || !fieldPath) return bad(env, "key and path are required");
    const { docKey, override } = await loadMerged(env, kind, site);
    deletePath(override, fieldPath);
    await saveDoc(env, docKey, override, { logChange: `Web admin reset ${fieldPath} to default` });
    return json({ ok: true }, env);
  }

  // POST /api/admin/doc/replace  { key, value }  — bulk overwrite (array
  // reorder/delete, discount table edits, ratings moderation, etc.)
  if (path === "/api/admin/doc/replace" && method === "POST") {
    const { key, value } = body || {};
    const { kind, site } = parseDocKey(key);
    if (!kind) return bad(env, "key is required");
    const docKey = docKeyFor(kind, site);
    await saveDoc(env, docKey, value, { logChange: `Web admin bulk-updated ${docKey}` });
    return json({ ok: true }, env);
  }

  // POST /api/admin/reset-all  — same as the bot's "🧨 Reset EVERYTHING"
  if (path === "/api/admin/reset-all" && method === "POST") {
    const perSiteKinds = ["content", "images", "prices", "highlights", "ratings"];
    for (const site of SITES) {
      for (const kind of perSiteKinds) {
        const base = defaultsFor(kind, site);
        await saveDoc(env, docKeyFor(kind, site), Array.isArray(base) ? [] : {}, {
          logChange: `Reset ALL ${kind} for ${site} (full site reset, via web admin)`,
        });
      }
    }
    await saveDoc(env, "discounts:global", {}, { logChange: "Reset ALL discounts (full site reset, via web admin)" });
    return json({ ok: true }, env);
  }

  // ---- image / video upload (bytes -> Telegram file_id -> stored) ----
  // POST /api/admin/upload-image  { site, key, filename, mimeType, base64 }
  if (path === "/api/admin/upload-image" && method === "POST") {
    const { site, key, filename, mimeType, base64 } = body || {};
    if (!isValidSite(site) || !key || !base64) return bad(env, "site, key and base64 are required");
    const bytes = base64ToBytes(base64);
    const sent = await tgSendPhotoBytes(env, env.TELEGRAM_ADMIN_CHAT_ID, bytes, filename, mimeType, `🖼️ ${site} / ${key} — uploaded via web admin`);
    if (!sent || !sent.ok) return bad(env, sent?.description || "Telegram upload failed", 502);
    const photos = sent.result.photo || [];
    const fileId = photos.length ? photos[photos.length - 1].file_id : sent.result.document?.file_id;
    if (!fileId) return bad(env, "Telegram didn't return a file id", 502);
    const docKey = `images:${site}`;
    const override = await getDoc(env, docKey, {});
    override[key] = fileId;
    await saveDoc(env, docKey, override, { logChange: `Photo changed via web admin: ${key}` });
    return json({ ok: true, url: `/media/${site}/${key}` }, env);
  }

  // POST /api/admin/upload-video  { site, key, filename, mimeType, base64 }
  if (path === "/api/admin/upload-video" && method === "POST") {
    const { site, key, filename, mimeType, base64 } = body || {};
    if (!isValidSite(site) || !key || !base64) return bad(env, "site, key and base64 are required");
    const bytes = base64ToBytes(base64);
    const sent = await tgSendVideoBytes(env, env.TELEGRAM_ADMIN_CHAT_ID, bytes, filename, mimeType, `🎬 ${site} / ${key} — uploaded via web admin`);
    if (!sent || !sent.ok) return bad(env, sent?.description || "Telegram upload failed", 502);
    const fileId = sent.result.video?.file_id;
    if (!fileId) return bad(env, "Telegram didn't return a file id", 502);
    const docKey = `videos:${site}`;
    const doc = await getDoc(env, docKey, {});
    doc[key] = fileId;
    await saveDoc(env, docKey, doc, { logChange: `Background video changed via web admin: ${key}` });
    return json({ ok: true, url: `/media-video/${site}/${key}` }, env);
  }

  // ---- guides ----
  if (path === "/api/admin/guides" && method === "GET") {
    const guides = await getGuides(env);
    return json({ ok: true, guides, sitePackages: SITE_PACKAGES, guideSites: GUIDE_SITES }, env);
  }
  if (path === "/api/admin/guides/pending" && method === "GET") {
    return json({ ok: true, pending: await listPendingGuides(env) }, env);
  }
  if (path === "/api/admin/guides" && method === "POST") {
    const { name, site, services } = body || {};
    if (!GUIDE_SITES.includes(site)) return bad(env, "valid site is required");
    const { guide, code } = await createGuide(env, { name, site, services });
    return json({ ok: true, guide, code }, env);
  }
  const guideMatch = path.match(/^\/api\/admin\/guides\/([^/]+)(?:\/(.+))?$/);
  if (guideMatch) {
    const [, guideId, sub] = guideMatch;
    if (method === "DELETE" && !sub) {
      await removeGuide(env, guideId);
      return json({ ok: true }, env);
    }
    if (method === "POST" && sub === "approve") {
      const updated = await approveGuide(env, guideId);
      if (!updated) return bad(env, "not found", 404);
      return json({ ok: true, guide: updated }, env);
    }
    if (method === "POST" && sub === "reject") {
      await rejectGuide(env, guideId);
      return json({ ok: true }, env);
    }
    if (method === "POST" && sub === "toggle-active") {
      const guide = await getGuide(env, guideId);
      if (!guide) return bad(env, "not found", 404);
      const updated = await setGuideActive(env, guideId, !guide.active);
      return json({ ok: true, guide: updated }, env);
    }
    if (method === "POST" && sub === "toggle-access") {
      const guide = await getGuide(env, guideId);
      if (!guide) return bad(env, "not found", 404);
      const updated = await setGuideBookingAccess(env, guideId, guide.bookingAccess === false);
      return json({ ok: true, guide: updated }, env);
    }
    if (method === "POST" && sub === "regenerate-code") {
      const code = await regenerateGuideCode(env, guideId);
      if (!code) return bad(env, "not found", 404);
      return json({ ok: true, code }, env);
    }
    if (method === "GET" && sub === "bookings") {
      const ids = await getGuideBookingIds(env, guideId);
      const bookings = await loadBookings(env, ids);
      return json({ ok: true, bookings }, env);
    }
  }

  // ---- payment gateway ----
  const payMatch = path.match(/^\/api\/admin\/payments\/([^/]+)$/);
  if (payMatch && method === "GET") {
    const site = payMatch[1];
    if (!isValidSite(site)) return bad(env, "bad site");
    const config = await getPaymentConfig(env, site);
    const creds = await getMaskedCredentials(env, site);
    return json({ ok: true, config, creds, gateways: GATEWAYS }, env);
  }
  if (payMatch && method === "POST") {
    const site = payMatch[1];
    if (!isValidSite(site)) return bad(env, "bad site");
    const { provider, enabled, currency, credentials } = body || {};
    const config = await getPaymentConfig(env, site);
    if (provider !== undefined) config.provider = provider;
    if (enabled !== undefined) config.enabled = !!enabled;
    if (currency !== undefined) config.currency = currency;
    await savePaymentConfig(env, site, config);
    if (credentials && typeof credentials === "object") {
      for (const [k, v] of Object.entries(credentials)) {
        if (v !== "" && v !== undefined) await setCredentialField(env, site, k, v);
      }
    }
    return json({ ok: true, config }, env);
  }

  // ---- ERA AI knowledge management ----
  if (path === "/api/admin/era/status" && method === "GET") {
    return json({ ok: true, status: await getEraStatusText(env) }, env);
  }
  if (path === "/api/admin/era/learning" && method === "POST") {
    const settings = await setLearningEnabled(env, !!(body || {}).enabled);
    return json({ ok: true, settings }, env);
  }
  if (path === "/api/admin/era/unanswered" && method === "GET") {
    return json({ ok: true, unanswered: await listUnanswered(env) }, env);
  }
  if (path === "/api/admin/era/answer" && method === "POST") {
    const { questionId, answer } = body || {};
    const okDone = await teachAnswer(env, questionId, answer);
    return json({ ok: okDone }, env, okDone ? 200 : 404);
  }
  if (path === "/api/admin/era/discard" && method === "POST") {
    await discardUnanswered(env, (body || {}).questionId);
    return json({ ok: true }, env);
  }
  if (path === "/api/admin/era/bulk-teach" && method === "POST") {
    const { text } = body || {};
    const { pairs, notes } = parseQABlob(text || "");
    const taught = await teachBulkAnswers(env, pairs);
    const noted = await addAdminNotes(env, notes);
    return json({ ok: true, taught, noted }, env);
  }
  if (path === "/api/admin/era/notes" && method === "GET") {
    return json({ ok: true, notes: await getAdminNotes(env) }, env);
  }

  // ---- visitor conversations (chat inbox) ----
  if (path === "/api/admin/conversations" && method === "GET") {
    const conversations = await listConversations(env, 150);
    return json({ ok: true, conversations }, env);
  }
  const convMatch = path.match(/^\/api\/admin\/conversations\/([^/]+)(?:\/(.+))?$/);
  if (convMatch) {
    const [, sessionId, sub] = convMatch;
    if (method === "GET" && !sub) {
      const log = await getConvLog(env, sessionId);
      const blocked = await isSessionBlocked(env, sessionId);
      return json({ ok: true, log, blocked }, env);
    }
    if (method === "POST" && sub === "reply") {
      const { text } = body || {};
      if (!text) return bad(env, "text is required");
      await pushOutbox(env, sessionId, text, "human");
      await appendConvLog(env, sessionId, [{ from: "human", text, ts: Date.now() }]);
      return json({ ok: true }, env);
    }
    if (method === "POST" && sub === "status") {
      const { status } = body || {}; // "ai" | "human" | "paused" | "closed"
      const conv = await setConversationStatus(env, sessionId, status);
      return json({ ok: !!conv, conv, label: conv ? statusLabel(conv.status) : undefined }, env, conv ? 200 : 404);
    }
    if (method === "POST" && sub === "toggle-active") {
      const conv = await toggleConversationActive(env, sessionId);
      return json({ ok: !!conv, conv }, env, conv ? 200 : 404);
    }
    if (method === "POST" && sub === "toggle-block") {
      const blocked = await toggleSessionBlocked(env, sessionId);
      return json({ ok: true, blocked }, env);
    }
  }

  // ---- stats ----
  if (path === "/api/admin/stats" && method === "GET") {
    return json({ ok: true, stats: await getLiveStats(env) }, env);
  }
  if (path === "/api/admin/stats/reset" && method === "POST") {
    await resetStats(env);
    return json({ ok: true }, env);
  }

  // ---- bookings (view + confirm/reject from the web, same as Telegram) ----
  if (path === "/api/admin/bookings/recent" && method === "GET") {
    const ids = JSON.parse((await env.BOOKINGS.get("recentbookings")) || "[]");
    const bookings = await loadBookings(env, ids);
    return json({ ok: true, bookings }, env);
  }
  const bookingMatch = path.match(/^\/api\/admin\/bookings\/([^/]+)\/(confirm|reject)$/);
  if (bookingMatch && method === "POST") {
    const [, bookingId, decision] = bookingMatch;
    await setBookingStatus(env, bookingId, decision === "confirm" ? "confirmed" : "cancelled");
    return json({ ok: true }, env);
  }

  return bad(env, "not found", 404);
}

// ---------------------------------------------------------------------
// GUIDE ROUTES — the web equivalent of sendGuideMenu / handleGuideCallback
// ---------------------------------------------------------------------
async function routeGuide(request, env, ctx, url, guide) {
  const path = url.pathname;
  const method = request.method;
  const body = method === "POST" ? await request.json().catch(() => ({})) : null;

  if (path === "/api/guide/me" && method === "GET") {
    return json({ ok: true, guide: publicGuide(guide), packages: SITE_PACKAGES[guide.site] || [] }, env);
  }
  if (guide.status === "pending" && path !== "/api/guide/me") {
    return bad(env, "Your request hasn't been approved by the admin yet.", 403);
  }
  if (path === "/api/guide/toggle-active" && method === "POST") {
    const updated = await setGuideActive(env, guide.id, !guide.active);
    return json({ ok: true, guide: publicGuide(updated) }, env);
  }
  if (path === "/api/guide/bookings" && method === "GET") {
    const ids = await getGuideBookingIds(env, guide.id);
    const bookings = await loadBookings(env, ids);
    return json({ ok: true, bookings }, env);
  }
  const m = path.match(/^\/api\/guide\/bookings\/([^/]+)\/(confirm|reject)$/);
  if (m && method === "POST") {
    const [, bookingId, decision] = m;
    // A guide may only decide bookings actually assigned to them.
    const ids = await getGuideBookingIds(env, guide.id);
    if (!ids.includes(bookingId)) return bad(env, "That booking isn't assigned to you.", 403);
    await setBookingStatus(env, bookingId, decision === "confirm" ? "confirmed" : "cancelled");
    return json({ ok: true }, env);
  }

  return bad(env, "not found", 404);
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
async function loadBookings(env, ids) {
  const recent = [...ids].reverse().slice(0, 100);
  const out = [];
  for (const id of recent) {
    const raw = await env.BOOKINGS.get(`booking:${id}`);
    const status = await env.BOOKINGS.get(`status:${id}`);
    if (!raw) continue;
    const booking = JSON.parse(raw);
    out.push({ id, status: status || "pending", ...booking });
  }
  return out;
}

function base64ToBytes(base64) {
  const clean = base64.includes(",") ? base64.split(",").pop() : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
