# Push to GitHub & view on GitHub Pages

This folder is already a git repository with one commit. You just add your remote and push, then turn on Pages. Because the app is gated by Supabase login + RLS, a public Pages URL is safe — a visitor can load the page but sees nothing without signing in. (The anon key is public by design.)

## 1. Fill in config first

Edit `js/config.js` with your real Supabase Project URL and anon key **before** pushing — for a hosted page the values must be present in the deployed files. The anon key is public-safe, so committing it is fine for an internal tool.

## 2. Create the repo and push

Pick whichever you use.

**With the GitHub CLI (`gh`):**
```bash
cd phase2
gh repo create cloudstaff-rfp-builder --private --source=. --remote=origin --push
```

**With plain git** (create an empty repo named `cloudstaff-rfp-builder` on github.com first — no README/licence — then):
```bash
cd phase2
git remote add origin https://github.com/<your-org-or-user>/cloudstaff-rfp-builder.git
git push -u origin main
```

## 3. Turn on Pages

In the repo on github.com: **Settings → Pages**.

- **Simplest — Deploy from a branch:** Source = *Deploy from a branch*, Branch = `main`, Folder = `/ (root)`, Save.
- **Or via Actions:** Source = *GitHub Actions* (this repo includes `.github/workflows/deploy-pages.yml`, which will build on every push to `main`).

After a minute your site is at:
```
https://<your-org-or-user>.github.io/cloudstaff-rfp-builder/
```

## Notes

- **No extra Supabase setup needed for password login** — email/password auth works from any origin, so the Pages URL just works. (You'd only add the URL to Supabase's redirect allow-list if you later switch to magic-link or OAuth logins.)
- **Private repo + Pages:** GitHub Pages on a private repo needs GitHub Team/Enterprise; on a free/personal account, Pages requires the repo be public. If it must stay private on a free plan, host on Netlify/Cloudflare Pages/Vercel instead — same static files, drag-and-drop or `git` deploy.
- If you'd rather not commit the anon key, keep `config.js` with placeholders in the repo and inject the real values at deploy time (e.g. a build step or an Actions secret) — happy to wire that up if you want it.
