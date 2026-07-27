# Cloudstaff RFP Builder

Cloudstaff's single source of truth for answering RFPs / RFIs — a Supabase-backed
web app, live at **https://leew-cs.github.io/RFP-Database/**.

Plain HTML/CSS/JS on the **Cloudstaff Design System v2.38**. No build step, no
framework. Current version: see `APP_VERSION` in `js/app.js` (shown on the login
page and sidebar).

## What it does

- **Knowledge base** — every RFP question has one consolidated, approved answer
  with full provenance (which client RFPs the answer came from and where it has
  been used since), version history, and attachable Library assets.
- **DRI ownership** — every category, question and Library asset has a Directly
  Responsible Individual. Only Editors/Admins can own things; Viewers are
  read-only and can't be assigned anything.
- **RFP response workflow** — upload a client RFP spreadsheet; questions are
  auto-matched against the knowledge base (TF-IDF). Strong untouched matches
  auto-approve; everything else is assigned to a DRI who writes/approves the
  answer. When nothing is pending, **Finalise and write Response** produces the
  filled document, stores it, and records provenance for every answer used.
- **Accountability** — the **Team Board** shows everyone, per active RFP, who is
  holding which answers, plus each person's outstanding knowledge-base upkeep
  (write / rework / monthly confirm). Public to all signed-in users by design.

## The screens

| Screen | Who | What |
|---|---|---|
| **My To Do** | DRIs | Answers to write/rework/confirm + RFP answers assigned to you |
| **Q&A Browser** | all | Search/filter the knowledge base; drawer with answer, history, provenance, attached assets; in-app editing for DRIs |
| **New RFP** | all | Upload a spreadsheet → auto-match → create a response project with DRI assignments |
| **RFP Responses** | all | Track each response project; review/approve rows; finalise the document |
| **RFP History** | all | Every RFP on record (historical sources + finalised responses); view its Q&A or download a Cloudstaff-formatted Excel |
| **Library** | all view; editors manage | Eight sections of supporting assets (videos are link-only). Assets have DRIs and stable IDs — edit/replace in place so question bindings never break; deleting is admin-only with a transfer tool |
| **Team Board** | all | Who is holding what, per RFP and per person |
| **Users & DRIs** | admin | Full user CRUD (create logins, edit, delete with ownership transfer), roles, category DRI mapping |

## Setup

1. **Database** — run the SQL in `phase1/` of the project workspace against a
   Supabase project, in order: the numbered schema/seed steps, then extensions
   **10–17** (audit-trigger fix, category_dris read policy, RFP workflow +
   storage, user auto-provision trigger, library + sections, asset governance,
   admin user RPCs). Each file states its expected check result.
2. **Config** — `js/config.js` holds the Supabase URL and anon/publishable key.
   Both are safe in a browser (RLS + auth protect the data). **Never** put the
   `service_role` key in any client file.
3. **Serve** — static files; GitHub Pages serves this repo from `main` / root.
   Any static host works. Sign-in is required to see anything.

## Files

```
index.html    app shell, login, all views, drawer + modals, inline logo sprite
css/app.css   app-layer overrides on top of the design system
js/config.js  Supabase URL + anon key
js/match.js   dependency-free TF-IDF question matcher (Node-testable)
js/app.js     all application logic (APP_VERSION lives here)
```

CDN scripts (order matters): supabase-js@2 → SheetJS 0.18.5 (spreadsheet
parse/fill) → ExcelJS 4.4.0 (styled History exports) → config → match.js →
app.js.

## Roles

- **Viewer** — read-only. Cannot own categories, questions or assets.
- **Editor** — a DRI: full CRUD within their assigned categories, Library
  management, RFP answer approval for rows assigned to them.
- **Admin** — everything, including user management and asset deletion.

Logins are created from **Users & DRIs** (admin) with a generated temporary
password. Deleting a user requires transferring everything they own first —
the delete dialog does it in one click.
