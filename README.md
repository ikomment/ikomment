# iKomment

**Privacy-first comments, Q&A, and forums for any website — in a 1.1KB embed.**

iKomment is an ultra-lightweight, self-hostable alternative to Disqus,
FastComments, and Talkyard. No ads. No tracking. No data selling. One script
tag.

```html
<div id="ikomment" data-module="comments"></div>
<script src="https://YOUR-DEPLOYMENT/cdn/i.js" data-site="YOUR_SITE_ID" async></script>
```

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ikomment/ikomment)

> ☁️ **iKomment Cloud** (we host it for you) is coming soon —
> [join the waitlist](https://ikomment.com/waitlist).

---

## Why iKomment

| | Disqus | FastComments | Talkyard | **iKomment** |
|---|---|---|---|---|
| Privacy | ❌ ad-funded | ✅ | ✅ | ✅ no tracking, ever |
| Initial payload | ~400KB | ~7KB | heavier | **1.1KB** loader |
| Comments + Q&A + Forums | ❌ | ❌ | ✅ | ✅ all three |
| AI spam detection | 💰 paid | ✅ | ❌ | ✅ free, built in |
| Self-hostable | ❌ | ❌ | ✅ | ✅ free, one click |
| Live chat | ❌ | ✅ | ✅ | ✅ per forum category |

Modules load lazily and only where used — a blog post never downloads forum
code. All heavy lifting happens at the edge; comments arrive pre-rendered.

## Features

- **Comments** — unlimited nesting, live updates, votes, pins, markdown,
  optimistic posting, "Continue thread →" for deep chains
- **Q&A** — accepted answers ✅, vote-sorted answers, per-answer discussion
- **Forums** — categories, threads, pinned/locked topics, member profiles,
  and a real-time **live chat** room per category
- **Identity** — guest posting, email sign-in links, Google, GitHub, and
  HMAC SSO for your own user system; every method is an owner toggle
- **Moderation** — AI spam detection (runs on your own Cloudflare account —
  data never leaves it), pre-moderation with automatic trust levels, word
  filters, shadow bans, one-click nuke, moderate-from-email, full audit log
- **Admin dashboard** — mobile-first, swipe to approve/spam, per-feature
  toggles with typed confirmation on consequential settings, per-page
  overrides, live theming preview, **Disqus one-click import**
- **Design** — adapts to its own container width, auto dark/light, fully
  fluid from 320px phones to ultrawide desktops

## Self-hosting (free)

Runs entirely on Cloudflare's free tier: Workers + D1 + KV + Durable Objects.
No server to rent, nothing to patch.

1. **Deploy** — click the button above, or manually:
   ```bash
   git clone https://github.com/ikomment/ikomment && cd ikomment
   npx wrangler d1 create ikomment            # paste the id into wrangler.toml
   npx wrangler kv namespace create CACHE     # paste the id into wrangler.toml
   npx wrangler d1 execute ikomment --file=schema.sql
   npx wrangler deploy
   ```
2. **Host the widget files** — upload `cdn/` and `dashboard/` to Cloudflare
   Pages (or serve them from the Worker).
3. **Create your site** — open the dashboard, sign up, copy your embed code.
4. **Optional extras** — secrets for what you enable:
   - Google login: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   - GitHub login: `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
   - Email (sign-in links + moderation): `RESEND_API_KEY` **or**
     `SENDGRID_API_KEY` — pick the provider in the dashboard

Full guides in [`docs/`](docs/): [Setup](docs/SETUP.md) ·
[SSO integration](docs/SSO.md) · [Disqus import](docs/IMPORT.md)

## Live demos

Try all four demos live — comments, Q&A, forums + chat, and the admin dashboard — with simulated data. Nothing to install:

**[→ Try the demos at ikomment.com](https://ikomment.com/demos.html)**

## License

[Elastic License 2.0](LICENSE) with one supplementary condition: the
**"Powered by iKomment" attribution must remain visible and unmodified** in
all deployments. In plain English: self-host it, modify it, use it on as many
of your own sites as you like, free forever — but don't resell it as a hosted
service, and leave the badge alone.

## Roadmap

See [ROADMAP.md](ROADMAP.md) — including the planned **Docker version** for
hosting anywhere (AWS, Hostinger, your own server) and **iKomment Cloud**.

---

*Built mobile-first, deployed from a phone. 📱*
