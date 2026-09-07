# 🚀 Fresh Setup — New Repo + New Cloudflare Account

This replaces the old `SETUP_INSTRUCTIONS.md` (which references secret
names — `WEBHOOK_SECRET`, `ADMIN_API_SECRET` — that don't actually
match the code anymore). Follow this one instead.

---

## 0. What you're setting up

Two repos:
1. **Backend** — a Cloudflare Worker (`src/index.js` + friends) — the API, Telegram bot, and web dashboard logic.
2. **Frontend** — your static site (`team-eplo-era-site`) + the new `admin/` and `guide/` dashboard folders — hosted on GitHub Pages.

They're separate repos that talk to each other over HTTPS. Do the backend first — the frontend needs its URL.

---

## 1. Backend — new Cloudflare Worker

### 1a. Create the new repo & install
```bash
git init chympe-booking-backend
cd chympe-booking-backend
# copy in the src/, wrangler.toml, package.json from backend-src-updated.zip
npm install
```

### 1b. Log into your NEW Cloudflare account
```bash
npx wrangler login
```
This opens a browser — make sure you authorize the **new** account, not an old one, if you have both open.

### 1c. Create a fresh KV namespace
```bash
npx wrangler kv namespace create BOOKINGS
```
It prints something like:
```toml
{ binding = "BOOKINGS", id = "a1b2c3d4e5f6..." }
```
Copy that `id` into `wrangler.toml`, replacing `PASTE_YOUR_NEW_KV_NAMESPACE_ID_HERE`.

### 1d. Fill in `wrangler.toml` [vars]
Edit these placeholders directly in the file (these are plain, non-secret values — safe to commit):

| Var | What it is | How to get it |
|---|---|---|
| `ADMIN_USER_IDS` | Your numeric Telegram user ID | Message `@userinfobot` on Telegram |
| `SITE_BASE_URL` | Your GitHub Pages URL | `https://YOUR-USERNAME.github.io/YOUR-REPO/` |
| `TELEGRAM_CHAT_ID` | Chat/group the bot posts bookings to | Add your bot to a group, then check `@RawDataBot` in that chat, or use the numeric ID from `getUpdates` (step 1f) |
| `TELEGRAM_ADMIN_CHAT_ID` | Chat for admin edit-logs + OTP fallback | Can be the same as above, or your personal DM with the bot |

> Reusing your old Telegram bot/group from before? Those three IDs
> don't change just because Cloudflare is new — paste the same values
> you already had.

### 1e. Set the real secrets (never go in wrangler.toml)
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# → paste the token from @BotFather

npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# → paste any random string you make up, e.g. run:
#   openssl rand -hex 20

npx wrangler secret put ADMIN_PASSWORD
# → your master admin password (break-glass login)

npx wrangler secret put ADMIN_SIGNUP_CODE
# → a second random string — only people you give this to can create a new admin account
```

Optional, for real SMS/email OTP instead of the Telegram fallback:
```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL
```

Verify:
```bash
npx wrangler secret list
```

### 1f. Deploy
```bash
npx wrangler deploy
```
Copy the URL it prints, e.g. `https://chympe-booking-backend.YOURNAME.workers.dev` — you'll need it twice below.

### 1g. Point your Telegram bot at the new Worker
Telegram doesn't know about your Worker until you register a webhook — this step is easy to forget and nothing will confirm/reject bookings without it:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://YOUR-WORKER-URL/telegram-webhook&secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>"
```
Should respond `{"ok":true,"result":true,...}`. If you don't have a bot yet, message `@BotFather` → `/newbot` first.

### 1h. Quick smoke test
```bash
curl https://YOUR-WORKER-URL/api/admin/sites
```
Expect `{"ok":false,"error":"Not authorized."}` (correct — you're not logged in yet). A network error or 500 means something above is missing.

---

## 2. Frontend — new repo + GitHub Pages

### 2a. Create the repo
```bash
git init team-eplo-era-site
cd team-eplo-era-site
# copy in your site files, plus admin/, guide/, dashboard-assets/ from dashboard-frontend.zip
```

### 2b. Set the Worker URL (one line, two files)
In both `admin/config.js` and `guide/config.js`:
```js
window.DASH_API_BASE = "https://YOUR-WORKER-URL"; // from step 1f, no trailing slash
```

### 2c. Add the Guide Login link to your nav
Anywhere your main nav markup lives:
```html
<a href="/guide/login.html">Guide Login</a>
```
The admin dashboard is intentionally **not** linked anywhere — reach it directly at `/admin/login.html`.

### 2d. Push & enable Pages
```bash
git add -A && git commit -m "Initial site + dashboards"
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```
Then on GitHub: **Settings → Pages → Source: Deploy from branch → main / (root)**.

### 2e. Go back and fix CORS + SITE_BASE_URL
Once your Pages URL is live:
- In the backend's `wrangler.toml`, set `ALLOWED_ORIGIN` to your exact Pages URL instead of `"*"` (tighter security), then `npx wrangler deploy` again.
- Update `SITE_BASE_URL` to match too.

---

## 3. First login

1. Go to `https://YOUR-PAGES-URL/admin/login.html`
2. Check "Use master password instead" → log in with `ADMIN_PASSWORD`
3. Once in, go to the **Sign Up** tab and create your real named admin account using `ADMIN_SIGNUP_CODE` (recommended, so you're not relying on the shared master password day-to-day)
4. Guides sign up or request to join at `https://YOUR-PAGES-URL/guide/login.html`, then you approve them from the admin **Guides** page

---

## 4. Checklist

- [ ] `wrangler kv namespace create BOOKINGS` run, id pasted into `wrangler.toml`
- [ ] All 4 `[vars]` placeholders filled in
- [ ] `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ADMIN_PASSWORD`, `ADMIN_SIGNUP_CODE` secrets set
- [ ] `wrangler deploy` succeeded, URL copied
- [ ] Telegram webhook registered (`setWebhook` call returned `ok:true`)
- [ ] `admin/config.js` and `guide/config.js` point at the new Worker URL
- [ ] GitHub Pages is live
- [ ] Logged into `/admin/login.html` with the master password at least once
