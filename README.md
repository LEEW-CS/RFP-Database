# Cloudstaff RFP Builder — Phase 2 (web interface, slice 1)

A plain HTML/CSS/JS front-end on the **Cloudstaff Design System v2.38** talking to the Phase 1 Supabase database. No build step, no framework. This first slice ships two screens:

- **Q&A Browser** — all 143 canonical questions, searchable and filterable by category, status and tier, with a detail drawer showing the canonical answer, most-recent source, DRI note, suggested attachments, and the full provenance trail.
- **My Attestations** — the questions in the categories you own as a DRI, with KPI tiles (owned / confirmed this month / needs an answer / awaiting confirmation) and one-click **Confirm accurate** / **Flag change needed**, written to the `attestations` table (audited).

Plus: dark/light theme toggle, collapsible sidebar, Cloudstaff branding.

## 1. Configure (30 seconds)

Open `js/config.js` and paste two values from Supabase → **Settings → API**:

```js
window.RFP_CONFIG = {
  SUPABASE_URL:      "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-OR-PUBLISHABLE-KEY"
};
```

Both are safe in a browser — Row-Level Security protects the data and users must sign in. **Do not** put the `service_role` key here.

## 2. Run it

Serve the folder over HTTP (auth is happier over http/https than `file://`):

```bash
cd phase2
python3 -m http.server 8080
# open http://localhost:8080
```

Sign in with a user you created in Supabase Auth — e.g. `driuser1@cloudstaff.com` with the password you set when adding them. Because the read policies are `to authenticated`, you must be signed in to see anything (this is intended for an internal tool).

## 3. Deploy

It's static files — host anywhere: Netlify, Vercel, Cloudflare Pages, GitHub Pages, or an internal Cloudstaff static host. (GitHub deployment is a later Phase 2 to-do; for now local or any static host works.) Set the two config values for the target environment before publishing.

## What each screen does

**Q&A Browser** loads `v_canonical` (question + category + current answer), tallies provenance counts, and renders a clickable table. The search box matches ID, question and answer text; the three dropdowns filter by category / status / tier. Clicking a row opens the drawer, which lazy-loads that question's provenance rows and shows any reference resources whose `supports` field names the question (e.g. the Modern Slavery Statement appears under ES-01/ES-05).

**My Attestations** reads `category_dris` for the signed-in user to find their categories, lists the questions in them, and shows when each was last confirmed. "Confirm accurate" inserts a `confirmed` attestation; "Flag change needed" prompts for a note and inserts a `changed` attestation. The RLS policy only lets a DRI attest questions in their own categories, so the buttons only appear where you're the owner.

## Files

```
index.html        app shell, login, both views, detail drawer
css/app.css        app-layer overrides (all via design-system tokens)
js/config.js       <-- you edit this (URL + anon key)
js/app.js          all logic: auth, data load, browser, drawer, attestation
```

## Notes & limits (this slice)

- Editing answers in-app (DRI CRUD → new answer version) is the **next** slice — this one is browse + attest.
- Not yet built (later Phase 2): new-RFP upload/match/write-back, per-client history, win-improvement dashboard, region/currency response builder.
- The design system is loaded from `https://style.cloudstaff.com/v2.38.0/css/ui.min.css`. If Cloudstaff pins a specific version, change that one URL in `index.html`.
- Theme, session and last-used view persist in `localStorage`.
