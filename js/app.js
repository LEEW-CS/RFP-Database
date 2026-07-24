/* ==========================================================================
   Cloudstaff RFP Builder — Phase 2 front-end (Q&A Browser + My Attestations)
   Plain vanilla JS + supabase-js. No build step.
   ========================================================================== */
(function () {
  "use strict";

  const cfg = window.RFP_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON");

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));

  // ---- status / tier presentation ----------------------------------------
  const STATUS = {
    "approved":        { cls: "badge-success", label: "Approved" },
    "approved-blank":  { cls: "badge-warning", label: "Needs answer" },
    "edit-pending":    { cls: "badge-info",    label: "Edit pending" },
    "sample-only":     { cls: "badge-neutral", label: "Sample only" }
  };
  const statusBadge = (s) => { const m = STATUS[s] || { cls: "badge-neutral", label: s }; return `<span class="badge ${m.cls} badge-sm">${esc(m.label)}</span>`; };
  const tierBadge = (t) => `<span class="badge ${t === "Client" ? "badge-brand" : "badge-neutral"} badge-sm">${esc(t)}</span>`;

  // ---- toast ---------------------------------------------------------------
  function toast(msg, kind = "success") {
    const t = el("div", `toast is-${kind}`, `<strong>${esc(msg)}</strong>`);
    $("#toast-stack").appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 2800);
  }

  // ---- theme ---------------------------------------------------------------
  function initTheme() {
    const saved = localStorage.getItem("rfp-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    syncThemeIcon();
    $("#theme-toggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("rfp-theme", next);
      syncThemeIcon();
    });
  }
  function syncThemeIcon() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    $("#theme-toggle i").className = dark ? "fa-solid fa-sun" : "fa-solid fa-moon";
  }

  // ---- state ---------------------------------------------------------------
  const state = {
    sb: null, user: null, profile: null,
    myCategoryIds: new Set(),
    questions: [], categories: [], resources: [],
    provCounts: {}, latestAttest: {}
  };

  // ---- boot ----------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    wireStaticHandlers();
    if (!configured) { $("#config-warning").hidden = false; showLogin(); return; }
    state.sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data: { session } } = await state.sb.auth.getSession();
    if (session) { await onSignedIn(session.user); } else { showLogin(); }
  });

  function showLogin() { $("#login-view").hidden = false; $("#app-shell").hidden = true; }

  function wireStaticHandlers() {
    $("#login-form").addEventListener("submit", onLogin);
    $("#signout-btn").addEventListener("click", async () => { await state.sb.auth.signOut(); location.reload(); });
    $("[data-collapse]").addEventListener("click", () => $(".app-sidebar").classList.toggle("is-collapsed"));
    $$("[data-drawer-close]").forEach(b => b.addEventListener("click", closeDrawer));
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
    // nav routing
    $$("[data-nav]").forEach(a => a.addEventListener("click", () => setTimeout(route, 0)));
    window.addEventListener("hashchange", route);
    // filters
    ["#search", "#filter-category", "#filter-status", "#filter-tier"].forEach(sel =>
      $(sel).addEventListener("input", renderBrowser));
  }

  async function onLogin(e) {
    e.preventDefault();
    const btn = $("#login-btn"); const err = $("#login-error");
    err.hidden = true; btn.classList.add("is-loading"); btn.disabled = true;
    const { data, error } = await state.sb.auth.signInWithPassword({
      email: $("#email").value.trim(), password: $("#password").value
    });
    btn.classList.remove("is-loading"); btn.disabled = false;
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    await onSignedIn(data.user);
  }

  // ---- data load after sign-in --------------------------------------------
  async function onSignedIn(user) {
    state.user = user;
    $("#login-view").hidden = true; $("#app-shell").hidden = false;

    const sb = state.sb;
    const [cats, prof, dris, qs, res, prov, att] = await Promise.all([
      sb.from("categories").select("id,code,name,sort_order").order("sort_order"),
      sb.from("profiles").select("user_id,email,full_name,role").eq("user_id", user.id).maybeSingle(),
      sb.from("category_dris").select("category_id").eq("user_id", user.id),
      sb.from("v_canonical").select("*"),
      sb.from("resources").select("*"),
      sb.from("provenance").select("question_id").range(0, 5000),
      sb.from("attestations").select("question_id,outcome,attested_at").eq("user_id", user.id).order("attested_at", { ascending: false })
    ]);

    state.categories = cats.data || [];
    state.profile = prof.data || { email: user.email, full_name: user.email, role: "viewer" };
    state.myCategoryIds = new Set((dris.data || []).map(d => d.category_id));
    state.questions = (qs.data || []).sort((a, b) => a.id.localeCompare(b.id));
    state.resources = res.data || [];

    state.provCounts = {};
    (prov.data || []).forEach(r => { state.provCounts[r.question_id] = (state.provCounts[r.question_id] || 0) + 1; });

    state.latestAttest = {};
    (att.data || []).forEach(a => { if (!state.latestAttest[a.question_id]) state.latestAttest[a.question_id] = a; });

    renderUserBox();
    populateCategoryFilter();
    route();
  }

  function renderUserBox() {
    const name = state.profile.full_name || state.profile.email || "User";
    $("#user-name").textContent = name;
    $("#user-role").textContent = (state.profile.role || "viewer").replace(/^\w/, c => c.toUpperCase());
    $("#user-avatar").textContent = name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const owned = ownedQuestions().length;
    const nav = $("#attest-nav-count");
    if (owned) { nav.textContent = owned; nav.hidden = false; }
  }

  // ---- routing -------------------------------------------------------------
  function route() {
    const hash = location.hash || "#/browser";
    const view = hash.includes("attest") ? "attest" : "browser";
    $("#browser-view").hidden = view !== "browser";
    $("#attest-view").hidden = view !== "attest";
    $$("[data-nav]").forEach(a => a.classList.toggle("is-active", a.dataset.nav === view));
    if (view === "browser") renderBrowser(); else renderAttest();
  }

  // ---- Q&A BROWSER ---------------------------------------------------------
  function populateCategoryFilter() {
    const sel = $("#filter-category");
    state.categories.forEach(c => sel.appendChild(new Option(c.name, c.name)));
  }

  function filteredQuestions() {
    const q = $("#search").value.trim().toLowerCase();
    const cat = $("#filter-category").value;
    const st = $("#filter-status").value;
    const tier = $("#filter-tier").value;
    return state.questions.filter(row => {
      if (cat && row.category !== cat) return false;
      if (st && row.status !== st) return false;
      if (tier && row.tier !== tier) return false;
      if (q) {
        const hay = (row.id + " " + row.question + " " + (row.answer || "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderBrowser() {
    const rows = filteredQuestions();
    const tbody = $("#qa-rows"); tbody.innerHTML = "";
    $("#qa-empty").hidden = rows.length > 0;
    $("#browser-summary").textContent =
      `${rows.length} of ${state.questions.length} canonical questions · ${state.categories.length} categories`;
    rows.forEach(row => {
      const tr = el("tr");
      const cnt = state.provCounts[row.id] || 0;
      tr.innerHTML =
        `<td><code>${esc(row.id)}</code></td>` +
        `<td class="rfp-qa-q">${esc(row.question)}<small>${esc((row.answer || "No answer on file yet.").slice(0, 120))}</small></td>` +
        `<td>${esc(row.category)}</td>` +
        `<td>${tierBadge(row.tier)}</td>` +
        `<td>${statusBadge(row.status)}</td>` +
        `<td class="text-center rfp-src-count">${cnt}</td>`;
      tr.addEventListener("click", () => openDrawer(row));
      tbody.appendChild(tr);
    });
  }

  // ---- DETAIL DRAWER -------------------------------------------------------
  async function openDrawer(row) {
    $("#d-id").textContent = row.id;
    $("#d-badges").innerHTML = tierBadge(row.tier) + " " + statusBadge(row.status) +
      (row.needs_rework ? ' <span class="badge badge-info badge-sm">Rework</span>' : "") +
      (row.sample_only ? ' <span class="badge badge-neutral badge-sm">Sample only</span>' : "");

    const body = $("#drawer-body");
    const answerHtml = row.answer
      ? `<p class="rfp-answer">${esc(row.answer)}</p>`
      : `<div class="alert alert-warning banner-inline"><i class="alert-icon fa-solid fa-pen"></i><span>No answer on file yet — the owning DRI will complete this.</span></div>`;

    const isMine = state.myCategoryIds.has(catIdByName(row.category));
    const last = state.latestAttest[row.id];
    const attestBlock = isMine ? `
      <div class="card card-tinted-brand stack-sm">
        <div class="cluster" style="justify-content:space-between">
          <strong>You are the DRI for ${esc(row.category)}</strong>
          ${last ? `<span class="text-secondary text-sm">Last: ${fmtDate(last.attested_at)} (${esc(last.outcome)})</span>` : `<span class="text-secondary text-sm">Not yet confirmed</span>`}
        </div>
        <div class="cluster cluster-sm">
          <button class="button button-success button-sm" data-attest="confirmed"><i class="fa-solid fa-check"></i> Confirm accurate</button>
          <button class="button button-secondary button-sm" data-attest="changed"><i class="fa-solid fa-flag"></i> Flag change needed</button>
        </div>
      </div>` : "";

    const relatedRes = state.resources.filter(r => new RegExp("\\b" + row.id + "\\b").test(r.supports || ""));
    const resBlock = relatedRes.length ? `
      <div class="stack-sm">
        <h4>Suggested attachments</h4>
        ${relatedRes.map(r => `<div class="cluster cluster-sm"><i class="fa-solid fa-paperclip text-secondary"></i><span><strong>${esc(r.name)}</strong> <span class="text-secondary text-sm">— ${esc(r.type)}</span></span></div>`).join("")}
      </div>` : "";

    body.innerHTML =
      `<div class="stack-2xs"><h3>${esc(row.question)}</h3><span class="text-secondary">${esc(row.category)}</span></div>` +
      attestBlock +
      `<div class="stack-sm"><h4>Canonical answer</h4>${answerHtml}` +
        (row.answer_source ? `<p class="text-secondary text-sm">Most recent source: ${esc(row.answer_source)}</p>` : "") +
        (row.dri_action ? `<div class="alert alert-info banner-inline"><i class="alert-icon fa-solid fa-circle-info"></i><span><strong>DRI note:</strong> ${esc(row.dri_action)}</span></div>` : "") +
      `</div>` +
      resBlock +
      `<div class="stack-sm"><h4>Provenance <span class="badge badge-neutral badge-sm">${state.provCounts[row.id] || 0}</span></h4>
        <div id="prov-list"><span class="spinner spinner--sm" role="status" aria-label="Loading"></span></div></div>`;

    if (isMine) $$("[data-attest]", body).forEach(b => b.addEventListener("click", () => attest(row, b.dataset.attest)));

    $("#drawer-overlay").hidden = false;
    document.body.style.overflow = "hidden";

    // lazy load provenance rows
    const { data } = await state.sb.from("provenance")
      .select("source_name,source_ref,original_question,original_answer")
      .eq("question_id", row.id).order("id");
    const list = $("#prov-list");
    if (!data || !data.length) { list.innerHTML = `<p class="text-secondary">No source rows.</p>`; return; }
    list.innerHTML = data.map(p => `
      <div class="rfp-prov-item">
        <div class="rfp-prov-src">${esc(p.source_name)}${p.source_ref ? ` <span class="text-secondary text-sm">· ${esc(p.source_ref)}</span>` : ""}</div>
        ${p.original_question ? `<div class="rfp-prov-q text-sm">Q: ${esc(p.original_question)}</div>` : ""}
        ${p.original_answer ? `<div class="text-sm">A: ${esc(p.original_answer)}</div>` : ""}
      </div>`).join("");
  }

  function closeDrawer() { $("#drawer-overlay").hidden = true; document.body.style.overflow = ""; }

  // ---- ATTESTATION ---------------------------------------------------------
  async function attest(row, outcome) {
    let note = null;
    if (outcome === "changed") { note = prompt("What needs to change? (optional)") || null; }
    const { error } = await state.sb.from("attestations").insert({
      question_id: row.id, user_id: state.user.id, outcome, note
    });
    if (error) { toast(error.message, "danger"); return; }
    state.latestAttest[row.id] = { question_id: row.id, outcome, attested_at: new Date().toISOString() };
    toast(outcome === "confirmed" ? "Confirmed accurate" : "Flagged for change");
    closeDrawer();
    if (!$("#attest-view").hidden) renderAttest();
  }

  function ownedQuestions() {
    return state.questions.filter(q => state.myCategoryIds.has(catIdByName(q.category)));
  }

  function renderAttest() {
    const owned = ownedQuestions();
    $("#attest-not-dri").hidden = owned.length > 0;
    $("#attest-table-wrap").hidden = owned.length === 0;

    const monthKey = new Date().toISOString().slice(0, 7);
    const confirmedThisMonth = q => { const a = state.latestAttest[q.id]; return a && a.outcome === "confirmed" && a.attested_at.slice(0, 7) === monthKey; };

    $("#stat-owned").textContent = owned.length;
    $("#stat-attested").textContent = owned.filter(confirmedThisMonth).length;
    $("#stat-blank").textContent = owned.filter(q => q.status === "approved-blank" || !q.answer).length;
    $("#stat-due").textContent = owned.filter(q => !confirmedThisMonth(q)).length;
    $("#attest-summary").textContent = owned.length
      ? `You own ${owned.length} questions across ${new Set(owned.map(q => q.category)).size} categories.`
      : "";

    const tbody = $("#attest-rows"); tbody.innerHTML = "";
    owned.forEach(q => {
      const last = state.latestAttest[q.id];
      const done = confirmedThisMonth(q);
      const tr = el("tr");
      tr.innerHTML =
        `<td><code>${esc(q.id)}</code></td>` +
        `<td class="rfp-qa-q">${esc(q.question)}</td>` +
        `<td>${statusBadge(q.status)}</td>` +
        `<td class="text-sm">${last ? fmtDate(last.attested_at) + (done ? "" : "") : '<span class="text-secondary">—</span>'}</td>` +
        `<td class="text-right"></td>`;
      const actions = el("div", "cluster cluster-sm", "");
      actions.style.justifyContent = "flex-end";
      const view = el("button", "button button-tertiary button-sm", '<i class="fa-solid fa-eye"></i>');
      view.addEventListener("click", () => openDrawer(q));
      const conf = el("button", `button button-sm ${done ? "button-secondary" : "button-success"}`,
        done ? '<i class="fa-solid fa-check"></i> Confirmed' : '<i class="fa-solid fa-check"></i> Confirm');
      conf.disabled = done;
      conf.addEventListener("click", () => attest(q, "confirmed"));
      actions.append(view, conf);
      tr.lastChild.appendChild(actions);
      tbody.appendChild(tr);
    });
  }

  // ---- helpers -------------------------------------------------------------
  function catIdByName(name) { const c = state.categories.find(c => c.name === name); return c ? c.id : -1; }
  function fmtDate(iso) {
    try {
      if (window.ds && ds.i18n) return ds.i18n.formatDate(new Date(iso));
      return new Date(iso).toLocaleDateString();
    } catch (_) { return iso.slice(0, 10); }
  }
})();
