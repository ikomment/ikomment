# iKomment — Importing from Disqus

Bring your full comment history: nesting, names, emails, timestamps.

## 1. Export from Disqus
disqus.com → Admin → Community → **Export**. Disqus emails you a `.gz` file
(may take a while for large sites).

## 2. Import
Dashboard → More → **Import from Disqus** → **Choose export file** → pick
the `.gz` straight from your email download — no need to unzip. Watch the
progress bar; large archives import in batches automatically.

## What transfers
- All comments with nesting preserved
- Author names and emails (same email = same person across comments)
- Original timestamps
- Comments land under the right pages automatically (matched by URL)

## What doesn't
- Votes (Disqus doesn't include them in exports)
- Passwords/accounts — imported authors appear as named participants
- Disqus-deleted and Disqus-spam comments (filtered out on purpose)

Re-running an import will duplicate comments — do it once per export.

---
*iKomment — privacy-first comments, Q&A & forums · https://ikomment.com*
