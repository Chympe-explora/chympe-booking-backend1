/**
 * otp.js — one-time-password generation, storage, and delivery for the
 * web admin + guide accounts (signup verification and password reset).
 *
 * DELIVERY CHANNELS — all optional, pick whichever secrets you set:
 *
 *   SMS (Twilio)     needs: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *                            TWILIO_FROM_NUMBER   (wrangler secret put ...)
 *   Email (Resend)   needs: RESEND_API_KEY, RESEND_FROM_EMAIL
 *   Telegram         needs: TELEGRAM_ADMIN_CHAT_ID (you already have this)
 *                    — falls back to posting the code into your admin
 *                    Telegram chat, so OTP works out of the box even
 *                    before you set up a paid SMS/email account.
 *
 * If a requested channel isn't configured, sendOtp() automatically
 * falls back to Telegram (if configured) so nobody gets locked out
 * mid-setup. It always tells the caller which channel the code
 * actually went out on.
 *
 * Storage: KV `otp:<purpose>:<identifier>` -> { code, expiresAt, attempts }
 * purpose is a short tag like "admin-signup", "admin-reset",
 * "guide-signup", "guide-reset" — keeps a stray SMS code for one flow
 * from validating a different flow for the same identifier.
 */

import { tgSendMessage } from "./telegram.js";

const OTP_TTL_SECONDS = 10 * 60; // 10 minutes
const MAX_ATTEMPTS = 5;

function randomOtp() {
  const bytes = new Uint8Array(1);
  let code = "";
  for (let i = 0; i < 6; i++) {
    crypto.getRandomValues(bytes);
    code += String(bytes[0] % 10);
  }
  return code;
}

function otpKey(purpose, identifier) {
  return `otp:${purpose}:${String(identifier).trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------
// Delivery adapters
// ---------------------------------------------------------------------

async function sendViaTwilio(env, phone, text) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) return { ok: false, reason: "not configured" };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const body = new URLSearchParams({ To: phone, From: env.TWILIO_FROM_NUMBER, Body: text });
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return { ok: false, reason: await res.text().catch(() => "twilio error") };
  return { ok: true };
}

async function sendViaResend(env, email, subject, text) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return { ok: false, reason: "not configured" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [email], subject, text }),
  });
  if (!res.ok) return { ok: false, reason: await res.text().catch(() => "resend error") };
  return { ok: true };
}

async function sendViaTelegram(env, label, code) {
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) return { ok: false, reason: "not configured" };
  const sent = await tgSendMessage(env, chatId, `🔑 <b>Verification code</b>\n${label}\nCode: <b>${code}</b>\nExpires in 10 minutes.`);
  return sent && sent.ok ? { ok: true } : { ok: false, reason: "telegram send failed" };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

// purpose: short tag, e.g. "admin-signup" | "admin-reset" | "guide-signup" | "guide-reset"
// identifier: the phone or email the code is tied to (also used as the KV key)
// channel: "sms" | "email" | "telegram" | "auto" (auto tries sms/email based on
//          which of phone/email was given, then falls back to telegram)
export async function sendOtp(env, { purpose, identifier, phone, email, channel = "auto", label = "" }) {
  const code = randomOtp();
  await env.BOOKINGS.put(otpKey(purpose, identifier), JSON.stringify({ code, expiresAt: Date.now() + OTP_TTL_SECONDS * 1000, attempts: 0 }), {
    expirationTtl: OTP_TTL_SECONDS,
  });

  const text = `Your Team Explo Era verification code is ${code}. It expires in 10 minutes. Don't share this with anyone.`;
  const attempts = [];

  if (channel === "sms" || (channel === "auto" && phone)) attempts.push(["sms", () => sendViaTwilio(env, phone, text)]);
  if (channel === "email" || (channel === "auto" && email)) attempts.push(["email", () => sendViaResend(env, email, "Your verification code", text)]);
  if (channel === "telegram") attempts.push(["telegram", () => sendViaTelegram(env, label, code)]);

  for (const [via, fn] of attempts) {
    const result = await fn();
    if (result.ok) return { ok: true, channel: via };
  }
  // Nothing configured / everything failed — fall back to Telegram so
  // setup isn't blocked while you're still adding SMS/email secrets.
  const fallback = await sendViaTelegram(env, label, code);
  if (fallback.ok) return { ok: true, channel: "telegram", fallback: true };

  return { ok: false, error: "No OTP delivery channel is configured yet. Set TWILIO_* or RESEND_* secrets, or TELEGRAM_ADMIN_CHAT_ID as a fallback." };
}

// Returns { ok, error? }. On success, the OTP is consumed (deleted) so
// it can't be replayed.
export async function verifyOtp(env, { purpose, identifier, code }) {
  const key = otpKey(purpose, identifier);
  const raw = await env.BOOKINGS.get(key);
  if (!raw) return { ok: false, error: "Code expired or not requested. Ask for a new one." };

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Code expired or not requested. Ask for a new one." };
  }

  if (Date.now() > record.expiresAt) {
    await env.BOOKINGS.delete(key);
    return { ok: false, error: "Code expired. Ask for a new one." };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    await env.BOOKINGS.delete(key);
    return { ok: false, error: "Too many wrong attempts. Ask for a new code." };
  }
  if (String(code).trim() !== record.code) {
    record.attempts += 1;
    await env.BOOKINGS.put(key, JSON.stringify(record), { expirationTtl: OTP_TTL_SECONDS });
    return { ok: false, error: "Wrong code." };
  }

  await env.BOOKINGS.delete(key);
  return { ok: true };
}
