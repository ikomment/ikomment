# iKomment — SSO Integration (one page, as promised)

Let your site's logged-in users comment without a separate iKomment login.

## 1. Get your secret
Dashboard → Identity & SSO → enable **SSO** → **Generate SSO secret**.
Keep it on your server only.

## 2. Sign a token on your server
Build this for each logged-in user (any language; Node shown):
```js
const crypto = require("crypto");
const payload = Buffer.from(JSON.stringify({
  id: user.id,              // required — stable id in YOUR system
  name: user.name,          // required
  email: user.email,        // optional
  avatar: user.avatarUrl,   // optional
  ts: Math.floor(Date.now() / 1000)   // required — must be fresh (10 min)
})).toString("base64");
const sig = crypto.createHmac("sha256", SSO_SECRET).update(payload).digest("hex");
const token = payload + "." + sig;
```

## 3. Put it in your page
```html
<script>window.iKommentSSO = "TOKEN_FROM_YOUR_SERVER";</script>
```
That's it. The widget sends it automatically; iKomment verifies the
signature and your user comments as themselves.

## Security notes
- Tokens expire after 10 minutes — generate per page load.
- A tampered token (changed name/id) fails verification and is ignored.
- Regenerating the secret (typed confirmation required) invalidates all
  existing integrations until your server uses the new one.

---
*iKomment — privacy-first comments, Q&A & forums · https://ikomment.com*
