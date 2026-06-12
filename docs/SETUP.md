# iKomment — Full Setup Guide

## What you need
A free Cloudflare account. That's it — no server, no credit card.

## 1. Deploy the backend
```bash
git clone https://github.com/ikomment/ikomment && cd ikomment
npx wrangler d1 create ikomment
#   → copy the database_id into wrangler.toml
npx wrangler kv namespace create CACHE
#   → copy the id into wrangler.toml
npx wrangler d1 execute ikomment --file=schema.sql
npx wrangler deploy
```
Note the Worker URL you get (e.g. `https://ikomment-api.you.workers.dev`).

## 2. Host the widget + dashboard
Upload the `cdn/` folder and `dashboard/dashboard.html` to Cloudflare Pages
(drag-and-drop in the dashboard works). Any static host is fine.

## 3. Create your site
Open the dashboard, choose **Create your site**, and copy your embed code
from **Settings → Embed code**:
```html
<div id="ikomment" data-module="comments"></div>
<script src="https://YOUR-PAGES-URL/cdn/i.js" data-site="YOUR_SITE_ID" async></script>
```
Use `data-module="qa"` or `data-module="forum"` on pages that want those
modules instead.

## 4. Optional: sign-in providers
Set only what you enable in the dashboard:
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put RESEND_API_KEY      # or SENDGRID_API_KEY
```
OAuth callback URLs to register with Google/GitHub:
```
https://YOUR-WORKER-URL/api/auth/google/callback
https://YOUR-WORKER-URL/api/auth/github/callback
```

## 5. Phone-only? You're covered
Everything above runs in GitHub Codespaces from a mobile browser. The
dashboard itself is designed mobile-first.

## Troubleshooting
- **Widget doesn't appear** → check the browser console; verify `data-site`
  matches your dashboard's Settings page, and that your Worker URL is
  reachable.
- **"login is not configured"** → the matching secret isn't set (step 4).
- **Chat tab missing** → enable Live chat for that category under
  Dashboard → Forum categories.

---
*iKomment — privacy-first comments, Q&A & forums · https://ikomment.com*
