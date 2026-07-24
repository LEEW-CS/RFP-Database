/* ==========================================================================
   Cloudstaff RFP Builder — Phase 2 front-end
   Q&A Browser · My Attestations · in-app editing (edit / add / soft-delete)
   Plain vanilla JS + supabase-js. No build step.
   ========================================================================== */
(function () {
  "use strict";

  const APP_VERSION = "v0.5.0";

  const cfg = window.RFP_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON");

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));

  const STATUS = {
    "approved":        { cls: "badge-success", label: "Approved" },
    "approved-blank":  { cls: "badge-warning", label: "Needs answer" },
    "edit-pending":    { cls: "badge-info",    label: "Edit pending" },
    "sample-only":     { cls: "badge-neutral", label: "Sample only" }
  };
  const STATUS_OPTS = ["approved", "approved-blank", "edit-pending", "sample-only"];
  const statusBadge = (s) => { const m = STATUS[s] || { cls: "badge-neutral", label: s }; return `<span class="badge ${m.cls} badge-sm">${esc(m.label)}</span>`; };
  const tierBadge = (t) => `<span class="badge ${t === "Client" ? "badge-brand" : "badge-neutral"} badge-sm">${esc(t)}</span>`;

  function toast(msg, kind = "success") {
    const t = el("div", `toast is-${kind}`, `<strong>${esc(msg)}</strong>`);
    $("#toast-stack").appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 2800);
  }

  function initTheme() {
    const saved = localStorage.getItem("rfp-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    syncThemeIcon();
    $("#theme-toggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("rfp-theme", next); syncThemeIcon();
    });
  }
  function syncThemeIcon() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    $("#theme-toggle i").className = dark ? "fa-solid fa-sun" : "fa-solid fa-moon";
  }

  const state = {
    sb: null, user: null, profile: null,
    myCategoryIds: new Set(),
    questions: [], categories: [], resources: [],
    provCounts: {}, latestAttest: {}, current: null,
    imp: null           // New-RFP import session (see import module below)
  };

  const isAdmin = () => (state.profile && state.profile.role === "admin");
  const isEditor = () => (state.profile && (state.profile.role === "admin" || state.profile.role === "editor"));
  const catIdByName = (name) => { const c = state.categories.find(c => c.name === name); return c ? c.id : -1; };
  const canEdit = (row) => isAdmin() || state.myCategoryIds.has(catIdByName(row.category));

  function setVersion() {
    ["#app-version-login", "#app-version-side"].forEach(sel => { const n = $(sel); if (n) n.textContent = APP_VERSION; });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    initTheme(); setVersion(); wireStaticHandlers();
    if (!configured) { $("#config-warning").hidden = false; showLogin(); return; }
    state.sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data: { session } } = await state.sb.auth.getSession();
    if (session) await onSignedIn(session.user); else showLogin();
  });

  function showLogin() { $("#login-view").hidden = false; $("#app-shell").hidden = true; }

  function wireStaticHandlers() {
    $("#login-form").addEventListener("submit", onLogin);
    $("#signout-btn").addEventListener("click", async () => { await state.sb.auth.signOut(); location.reload(); });
    $("[data-collapse]").addEventListener("click", () => $(".app-sidebar").classList.toggle("is-collapsed"));
    $$("[data-drawer-close]").forEach(b => b.addEventListener("click", closeDrawer));
    $$("[data-newq-close]").forEach(b => b.addEventListener("click", closeNewQ));
    document.addEventListener("keydown", e => { if (e.key === "Escape") { closeDrawer(); closeNewQ(); } });
    $$("[data-nav]").forEach(a => a.addEventListener("click", () => setTimeout(route, 0)));
    window.addEventListener("hashchange", route);
    ["#search", "#filter-category", "#filter-status", "#filter-tier"].forEach(sel => $(sel).addEventListener("input", renderBrowser));
    $("#new-q-btn").addEventListener("click", openNewQ);
    $("#newq-save").addEventListener("click", saveNewQ);
    wireImportHandlers();
  }

  async function onLogin(e) {
    e.preventDefault();
    const btn = $("#login-btn"), err = $("#login-error");
    err.hidden = true; btn.classList.add("is-loading"); btn.disabled = true;
    const { data, error } = await state.sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
    btn.classList.remove("is-loading"); btn.disabled = false;
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    await onSignedIn(data.user);
  }

  async function onSignedIn(user) {
    state.user = user;
    $("#login-view").hidden = true; $("#app-shell").hidden = false;
    const sb = state.sb;
    const [cats, prof, dris, res, prov, att] = await Promise.all([
      sb.from("categories").select("id,code,name,sort_order").order("sort_order"),
      sb.from("profiles").select("user_id,email,full_name,role").eq("user_id", user.id).maybeSingle(),
      sb.from("category_dris").select("category_id").eq("user_id", user.id),
      sb.from("resources").select("*"),
      sb.from("provenance").select("question_id").range(0, 5000),
      sb.from("attestations").select("question_id,outcome,attested_at").eq("user_id", user.id).order("attested_at", { ascending: false })
    ]);
    state.categories = cats.data || [];
    state.profile = prof.data || { email: user.email, full_name: user.email, role: "viewer" };
    state.myCategoryIds = new Set((dris.data || []).map(d => d.category_id));
    state.resources = res.data || [];
    state.provCounts = {};
    (prov.data || []).forEach(r => { state.provCounts[r.question_id] = (state.provCounts[r.question_id] || 0) + 1; });
    state.latestAttest = {};
    (att.data || []).forEach(a => { if (!state.latestAttest[a.question_id]) state.latestAttest[a.question_id] = a; });
    await loadQuestions();
    renderUserBox(); populateCategoryFilter(); populateNewQCats(); route();
  }

  async function loadQuestions() {
    const { data } = await state.sb.from("v_canonical").select("*");
    state.questions = (data || []).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  function renderUserBox() {
    const name = state.profile.full_name || state.profile.email || "User";
    $("#user-name").textContent = name;
    $("#user-role").textContent = (state.profile.role || "viewer").replace(/^\w/, c => c.toUpperCase());
    $("#user-avatar").textContent = name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const todo = ownedQuestions().filter(q => todoFor(q).rank < 3).length;
    const nav = $("#attest-nav-count");
    if (todo) { nav.textContent = todo; nav.hidden = false; } else nav.hidden = true;
    $("#new-q-btn").hidden = !isEditor();
  }

  // What does this owned question still need? (lower rank = more urgent)
  function confirmedThisMonth(q) {
    const a = state.latestAttest[q.id];
    return !!(a && a.outcome === "confirmed" && a.attested_at.slice(0, 7) === new Date().toISOString().slice(0, 7));
  }
  function todoFor(q) {
    if (q.status === "approved-blank" || !q.answer) return { rank: 0, cls: "badge-warning", label: "Write answer" };
    if (q.needs_rework)                              return { rank: 1, cls: "badge-info",    label: "Rework" };
    if (!confirmedThisMonth(q))                      return { rank: 2, cls: "badge-neutral", label: "Confirm" };
    return { rank: 3, cls: "badge-success", label: "Up to date" };
  }

  function route() {
    let hash = location.hash;
    if (!hash) hash = ownedQuestions().length ? "#/attest" : "#/browser";  // DRIs land on To Do
    let view = "browser";
    if (hash.includes("attest")) view = "attest";
    else if (hash.includes("import")) view = "import";
    $("#browser-view").hidden = view !== "browser";
    $("#attest-view").hidden = view !== "attest";
    $("#import-view").hidden = view !== "import";
    $$("[data-nav]").forEach(a => a.classList.toggle("is-active", a.dataset.nav === view));
    if (view === "browser") renderBrowser();
    else if (view === "attest") renderAttest();
    else renderImport();
  }

  function populateCategoryFilter() {
    const sel = $("#filter-category");
    sel.length = 1;
    state.categories.forEach(c => sel.appendChild(new Option(c.name, c.name)));
  }

  function filteredQuestions() {
    const q = $("#search").value.trim().toLowerCase();
    const cat = $("#filter-category").value, st = $("#filter-status").value, tier = $("#filter-tier").value;
    return state.questions.filter(row => {
      if (cat && row.category !== cat) return false;
      if (st && row.status !== st) return false;
      if (tier && row.tier !== tier) return false;
      if (q) { const hay = (row.id + " " + row.question + " " + (row.answer || "")).toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
  }

  function renderBrowser() {
    const rows = filteredQuestions();
    const tbody = $("#qa-rows"); tbody.innerHTML = "";
    $("#qa-empty").hidden = rows.length > 0;
    $("#browser-summary").textContent = `${rows.length} of ${state.questions.length} consolidated questions · ${state.categories.length} categories`;
    rows.forEach(row => {
      const tr = el("tr"); const cnt = state.provCounts[row.id] || 0;
      tr.innerHTML =
        `<td><code>${esc(row.id)}</code></td>` +
        `<td class="rfp-qa-q">${esc(row.question)}<small>${esc((row.answer || "No answer on file yet.").slice(0, 120))}</small></td>` +
        `<td>${esc(row.category)}</td><td>${tierBadge(row.tier)}</td><td>${statusBadge(row.status)}</td>` +
        `<td class="text-center rfp-src-count">${cnt}</td>`;
      tr.addEventListener("click", () => openDrawer(row));
      tbody.appendChild(tr);
    });
  }

  // ---- DETAIL DRAWER (with editing) ---------------------------------------
  async function openDrawer(row) {
    state.current = row;
    $("#d-id").textContent = row.id;
    $("#d-badges").innerHTML = tierBadge(row.tier) + " " + statusBadge(row.status) +
      (row.needs_rework ? ' <span class="badge badge-info badge-sm">Rework</span>' : "") +
      (row.sample_only ? ' <span class="badge badge-neutral badge-sm">Sample only</span>' : "");
    renderDrawerBody(row, false);
    $("#drawer-overlay").hidden = false; document.body.style.overflow = "hidden";
  }

  function renderDrawerBody(row, editing) {
    const editable = canEdit(row);
    const isMine = state.myCategoryIds.has(catIdByName(row.category));
    const last = state.latestAttest[row.id];
    const body = $("#drawer-body");

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
      <div class="stack-sm"><h4>Suggested attachments</h4>
        ${relatedRes.map(r => `<div class="cluster cluster-sm"><i class="fa-solid fa-paperclip text-secondary"></i><span><strong>${esc(r.name)}</strong> <span class="text-secondary text-sm">— ${esc(r.type)}</span></span></div>`).join("")}
      </div>` : "";

    // answer area (view or edit)
    let answerArea;
    if (editing) {
      answerArea = `
        <div class="stack-sm"><h4>Edit answer</h4>
          <textarea class="textarea rfp-answer-edit" id="edit-answer">${esc(row.answer || "")}</textarea>
          <div class="cluster cluster-sm">
            <button class="button button-primary button-sm" data-save-answer><i class="fa-solid fa-floppy-disk"></i> Save answer</button>
            <button class="button button-tertiary button-sm" data-cancel-edit>Cancel</button>
          </div>
        </div>`;
    } else {
      const answerHtml = row.answer
        ? `<p class="rfp-answer">${esc(row.answer)}</p>`
        : `<div class="alert alert-warning banner-inline"><i class="alert-icon fa-solid fa-pen"></i><span>No answer on file yet.</span></div>`;
      answerArea = `
        <div class="stack-sm">
          <div class="cluster" style="justify-content:space-between">
            <h4>Consolidated answer</h4>
            ${editable ? `<button class="button button-secondary button-sm" data-edit-answer><i class="fa-solid fa-pen"></i> Edit</button>` : ""}
          </div>
          ${answerHtml}
          ${row.answer_source ? `<p class="text-secondary text-sm">Most recent source: ${esc(row.answer_source)}</p>` : ""}
          ${row.dri_action ? `<div class="alert alert-info banner-inline"><i class="alert-icon fa-solid fa-circle-info"></i><span><strong>DRI note:</strong> ${esc(row.dri_action)}</span></div>` : ""}
        </div>`;
    }

    // editable meta (status / tier / rework / dri note / question text / delete)
    const metaBlock = editable ? `
      <details class="rfp-edit-card"><summary><strong>Edit details &amp; status</strong></summary>
        <div class="stack-sm" style="margin-top:var(--space-sm)">
          <div class="field"><label class="field-label">Question</label><textarea class="textarea" id="edit-question" rows="2">${esc(row.question)}</textarea></div>
          <div class="cluster cluster-sm">
            <div class="field flex-1"><label class="field-label">Status</label>
              <select class="select" id="edit-status">${STATUS_OPTS.map(s => `<option value="${s}" ${s === row.status ? "selected" : ""}>${STATUS[s].label}</option>`).join("")}</select></div>
            <div class="field flex-1"><label class="field-label">Tier</label>
              <select class="select" id="edit-tier"><option ${row.tier === "Client" ? "selected" : ""}>Client</option><option ${row.tier === "Internal" ? "selected" : ""}>Internal</option></select></div>
          </div>
          <label class="check"><input type="checkbox" id="edit-rework" ${row.needs_rework ? "checked" : ""}> Needs rework</label>
          <div class="field"><label class="field-label">DRI note (optional)</label><input class="input" id="edit-driaction" value="${esc(row.dri_action || "")}"></div>
          <div class="cluster" style="justify-content:space-between">
            <button class="button button-primary button-sm" data-save-meta><i class="fa-solid fa-floppy-disk"></i> Save details</button>
            <button class="button button-danger button-sm" data-delete><i class="fa-solid fa-trash"></i> Delete</button>
          </div>
        </div>
      </details>` : "";

    body.innerHTML =
      `<div class="stack-2xs"><h3>${esc(row.question)}</h3><span class="text-secondary">${esc(row.category)}</span></div>` +
      attestBlock + answerArea + metaBlock + resBlock +
      `<div class="stack-sm"><h4>Provenance <span class="badge badge-neutral badge-sm">${state.provCounts[row.id] || 0}</span></h4>
        <div id="prov-list"><span class="spinner spinner--sm" role="status" aria-label="Loading"></span></div></div>` +
      (editable ? `<details class="rfp-edit-card"><summary><strong>Answer history</strong></summary><div id="ver-list" style="margin-top:var(--space-sm)"></div></details>` : "");

    // wire actions
    if (isMine) $$("[data-attest]", body).forEach(b => b.addEventListener("click", () => attest(row, b.dataset.attest)));
    const on = (sel, fn) => { const n = $(sel, body); if (n) n.addEventListener("click", fn); };
    on("[data-edit-answer]", () => renderDrawerBody(row, true));
    on("[data-cancel-edit]", () => renderDrawerBody(row, false));
    on("[data-save-answer]", () => saveAnswer(row));
    on("[data-save-meta]", () => saveMeta(row));
    on("[data-delete]", () => deleteQuestion(row));
    const verDetails = $("details:last-of-type", body);
    if (editable && verDetails) verDetails.addEventListener("toggle", () => { if (verDetails.open) loadVersions(row.id); }, { once: true });
    if (!editing) loadProvenance(row.id);
  }

  async function loadProvenance(id) {
    const list = $("#prov-list"); if (!list) return;
    const { data } = await state.sb.from("provenance").select("source_name,source_ref,original_question,original_answer").eq("question_id", id).order("id");
    if (!$("#prov-list")) return;
    if (!data || !data.length) { $("#prov-list").innerHTML = `<p class="text-secondary">No source rows.</p>`; return; }
    $("#prov-list").innerHTML = data.map(p => `
      <div class="rfp-prov-item">
        <div class="rfp-prov-src">${esc(p.source_name)}${p.source_ref ? ` <span class="text-secondary text-sm">· ${esc(p.source_ref)}</span>` : ""}</div>
        ${p.original_question ? `<div class="rfp-prov-q text-sm">Q: ${esc(p.original_question)}</div>` : ""}
        ${p.original_answer ? `<div class="text-sm">A: ${esc(p.original_answer)}</div>` : ""}
      </div>`).join("");
  }

  async function loadVersions(id) {
    const list = $("#ver-list"); if (!list) return;
    list.innerHTML = `<span class="spinner spinner--sm" role="status"></span>`;
    const { data } = await state.sb.from("answer_versions").select("answer,answer_source,note,created_at").eq("question_id", id).order("created_at", { ascending: false });
    if (!data || !data.length) { list.innerHTML = `<p class="text-secondary">No history.</p>`; return; }
    list.innerHTML = data.map(v => `
      <div class="rfp-ver-item">
        <div class="cluster" style="justify-content:space-between"><strong class="text-sm">${esc(v.note || "Version")}</strong><span class="text-secondary text-xs">${fmtDate(v.created_at)}</span></div>
        <div class="rfp-ver-ans">${esc((v.answer || "(empty)").slice(0, 600))}</div>
      </div>`).join("");
  }

  function closeDrawer() { $("#drawer-overlay").hidden = true; document.body.style.overflow = ""; }

  // ---- mutations ----------------------------------------------------------
  async function saveAnswer(row) {
    const answer = $("#edit-answer").value.trim() || null;
    const src = `Edited in-app by ${state.profile.email} · ${new Date().toISOString().slice(0, 10)}`;
    const up = await state.sb.from("canonical_answers").upsert({ question_id: row.id, answer, answer_source: src, updated_by: state.user.id, updated_at: new Date().toISOString() }, { onConflict: "question_id" });
    if (up.error) return toast(up.error.message, "danger");
    await state.sb.from("answer_versions").insert({ question_id: row.id, answer, answer_source: src, note: `Edited by ${state.profile.email}`, created_by: state.user.id });
    // auto-approve a blank once answered
    if (answer && row.status === "approved-blank") {
      await state.sb.from("canonical_questions").update({ status: "approved", needs_rework: false }).eq("id", row.id);
    }
    toast("Answer saved");
    await refreshAndReopen(row.id);
  }

  async function saveMeta(row) {
    const patch = {
      question: $("#edit-question").value.trim(),
      status: $("#edit-status").value,
      tier: $("#edit-tier").value,
      needs_rework: $("#edit-rework").checked,
      dri_action: $("#edit-driaction").value.trim() || null
    };
    const { error } = await state.sb.from("canonical_questions").update(patch).eq("id", row.id);
    if (error) return toast(error.message, "danger");
    toast("Details saved");
    await refreshAndReopen(row.id);
  }

  async function deleteQuestion(row) {
    if (!confirm(`Delete ${row.id}? It is hidden from the database but kept in history (soft delete).`)) return;
    const { error } = await state.sb.from("canonical_questions").update({ deleted_at: new Date().toISOString() }).eq("id", row.id);
    if (error) return toast(error.message, "danger");
    toast(`${row.id} deleted`);
    closeDrawer();
    await loadQuestions(); route();
  }

  async function refreshAndReopen(id) {
    await loadQuestions();
    const fresh = state.questions.find(q => q.id === id);
    renderBrowser();
    if (fresh) { openDrawer(fresh); } else { closeDrawer(); }
  }

  // ---- new question -------------------------------------------------------
  function populateNewQCats() {
    const sel = $("#newq-cat"); sel.innerHTML = "";
    const cats = isAdmin() ? state.categories : state.categories.filter(c => state.myCategoryIds.has(c.id));
    cats.forEach(c => sel.appendChild(new Option(c.name, c.id)));
  }
  function openNewQ() {
    if (!isEditor()) return;
    populateNewQCats();
    $("#newq-question").value = ""; $("#newq-answer").value = ""; $("#newq-error").hidden = true;
    $("#newq-overlay").hidden = false; document.body.style.overflow = "hidden";
  }
  function closeNewQ() { $("#newq-overlay").hidden = true; document.body.style.overflow = ""; }

  function nextIdForCategory(catId) {
    const code = (state.categories.find(c => c.id === catId) || {}).code || "Q";
    let max = 0;
    state.questions.forEach(q => {
      const m = new RegExp("^" + code + "-(\\d+)$").exec(q.id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return `${code}-${String(max + 1).padStart(2, "0")}`;
  }

  async function saveNewQ() {
    const err = $("#newq-error"); err.hidden = true;
    const catId = parseInt($("#newq-cat").value, 10);
    const question = $("#newq-question").value.trim();
    const tier = $("#newq-tier").value;
    let status = $("#newq-status").value;
    const answer = $("#newq-answer").value.trim() || null;
    if (!catId || !question) { err.textContent = "Pick a category and enter the question."; err.hidden = false; return; }
    if (!answer && status === "approved") status = "approved-blank";
    const id = nextIdForCategory(catId);
    const btn = $("#newq-save"); btn.classList.add("is-loading"); btn.disabled = true;

    const q1 = await state.sb.from("canonical_questions").insert({ id, category_id: catId, question, tier, status, needs_rework: false, sample_only: false });
    if (q1.error) { btn.classList.remove("is-loading"); btn.disabled = false; err.textContent = q1.error.message; err.hidden = false; return; }
    const src = `Created in-app by ${state.profile.email} · ${new Date().toISOString().slice(0, 10)}`;
    await state.sb.from("canonical_answers").insert({ question_id: id, answer, answer_source: src, updated_by: state.user.id });
    await state.sb.from("answer_versions").insert({ question_id: id, answer, answer_source: src, note: `Created by ${state.profile.email}`, created_by: state.user.id });
    btn.classList.remove("is-loading"); btn.disabled = false;
    closeNewQ(); toast(`${id} created`);
    await loadQuestions(); renderBrowser();
    const fresh = state.questions.find(q => q.id === id); if (fresh) openDrawer(fresh);
  }

  // ---- attestation --------------------------------------------------------
  async function attest(row, outcome) {
    let note = null;
    if (outcome === "changed") note = prompt("What needs to change? (optional)") || null;
    const { error } = await state.sb.from("attestations").insert({ question_id: row.id, user_id: state.user.id, outcome, note });
    if (error) return toast(error.message, "danger");
    state.latestAttest[row.id] = { question_id: row.id, outcome, attested_at: new Date().toISOString() };
    toast(outcome === "confirmed" ? "Confirmed accurate" : "Flagged for change");
    if (state.current && state.current.id === row.id) renderDrawerBody(state.current, false);
    if (!$("#attest-view").hidden) renderAttest();
  }

  function ownedQuestions() { return state.questions.filter(q => state.myCategoryIds.has(catIdByName(q.category))); }

  function renderAttest() {
    const owned = ownedQuestions();
    $("#attest-not-dri").hidden = owned.length > 0;
    $("#attest-table-wrap").hidden = owned.length === 0;
    $("#stat-owned").textContent = owned.length;
    $("#stat-attested").textContent = owned.filter(confirmedThisMonth).length;
    $("#stat-blank").textContent = owned.filter(q => q.status === "approved-blank" || !q.answer).length;
    $("#stat-due").textContent = owned.filter(q => !confirmedThisMonth(q)).length;
    const todoCount = owned.filter(q => todoFor(q).rank < 3).length;
    $("#attest-summary").textContent = owned.length
      ? (todoCount ? `${todoCount} item${todoCount === 1 ? "" : "s"} need your attention across ${new Set(owned.map(q => q.category)).size} categories.`
                   : `All ${owned.length} of your questions are up to date. Nice.`)
      : "";

    // most urgent first, then by ID
    const rows = owned.slice().sort((a, b) => todoFor(a).rank - todoFor(b).rank || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const tbody = $("#attest-rows"); tbody.innerHTML = "";
    rows.forEach(q => {
      const last = state.latestAttest[q.id]; const td = todoFor(q); const done = confirmedThisMonth(q);
      const tr = el("tr");
      tr.innerHTML =
        `<td><code>${esc(q.id)}</code></td>` +
        `<td class="rfp-qa-q">${esc(q.question)}</td>` +
        `<td><span class="badge ${td.cls} badge-sm">${td.label}</span></td>` +
        `<td class="text-sm">${last ? fmtDate(last.attested_at) : '<span class="text-secondary">—</span>'}</td>` +
        `<td class="text-right"></td>`;
      const actions = el("div", "cluster cluster-sm", ""); actions.style.justifyContent = "flex-end";
      // primary action depends on what's needed
      if (td.rank <= 1) {
        const openBtn = el("button", "button button-primary button-sm", `<i class="fa-solid fa-pen"></i> ${td.rank === 0 ? "Write" : "Rework"}`);
        openBtn.addEventListener("click", () => openDrawer(q));
        actions.append(openBtn);
      } else {
        const view = el("button", "button button-tertiary button-sm", '<i class="fa-solid fa-eye"></i>');
        view.addEventListener("click", () => openDrawer(q));
        const conf = el("button", `button button-sm ${done ? "button-secondary" : "button-success"}`, done ? '<i class="fa-solid fa-check"></i> Confirmed' : '<i class="fa-solid fa-check"></i> Confirm');
        conf.disabled = done; conf.addEventListener("click", () => attest(q, "confirmed"));
        actions.append(view, conf);
      }
      tr.lastChild.appendChild(actions); tbody.appendChild(tr);
    });
  }

  function fmtDate(iso) { try { if (window.ds && ds.i18n) return ds.i18n.formatDate(new Date(iso)); return new Date(iso).toLocaleDateString(); } catch (_) { return String(iso).slice(0, 10); } }

  /* ========================================================================
     NEW RFP — upload → auto-match → review → export / write-back
     ======================================================================== */
  const IMP_BAND = {
    strong:  { cls: "badge-success", label: "Strong" },
    partial: { cls: "badge-warning", label: "Partial" },
    gap:     { cls: "badge-danger",  label: "No match" }
  };
  const colLetter = (n) => { let s = ""; n = n + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  function wireImportHandlers() {
    const dz = $("#import-dropzone"), file = $("#import-file");
    dz.addEventListener("click", () => file.click());
    dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
    dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("is-drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("is-drag"));
    dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("is-drag"); if (e.dataTransfer.files[0]) onImportFile(e.dataTransfer.files[0]); });
    file.addEventListener("change", () => { if (file.files[0]) onImportFile(file.files[0]); file.value = ""; });
    $("#import-reset").addEventListener("click", resetImport);
    $("#import-sheet").addEventListener("change", () => { impLoadSheet($("#import-sheet").value); });
    $("#import-headerrow").addEventListener("change", () => { state.imp.headerRow = parseInt($("#import-headerrow").value, 10); impRefreshColumns(); });
    $("#import-run").addEventListener("click", impRun);
    ["#import-search", "#import-filter-band"].forEach(s => $(s).addEventListener("input", renderImportRows));
    $("#import-download").addEventListener("click", impDownload);
    $("#import-pushkb").addEventListener("click", openKbModal);
    $$("[data-kb-close]").forEach(b => b.addEventListener("click", closeKbModal));
    $("#kb-save").addEventListener("click", saveKbQuestions);
  }

  function renderImport() {
    // idempotent: show whichever step the current session is in
    if (!window.XLSX) {
      $("#import-summary").textContent = "Spreadsheet engine still loading — give it a second and reopen New RFP.";
    }
    showStep(state.imp ? (state.imp.rows ? "review" : "config") : "upload");
    $("#import-reset").hidden = !state.imp;
  }

  function showStep(step) {
    $("#import-step-upload").hidden = step !== "upload";
    $("#import-step-config").hidden = step !== "config";
    $("#import-step-review").hidden = step !== "review";
    $("#import-reset").hidden = step === "upload";
  }

  function resetImport() {
    state.imp = null;
    $("#import-parse-error").hidden = true;
    showStep("upload");
    $("#import-reset").hidden = true;
    $("#import-summary").textContent = "Upload an RFP/RFI spreadsheet — we match each question against the knowledge base and draft the response for you.";
  }

  async function onImportFile(f) {
    const errBox = $("#import-parse-error");
    errBox.hidden = true;
    if (!window.XLSX) { showImpError("The spreadsheet engine hasn't loaded yet. Check your connection and try again."); return; }
    if (!/\.(xlsx|xls|xlsm|csv)$/i.test(f.name)) { showImpError("Please choose a .xlsx, .xls or .csv file."); return; }
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      if (!wb.SheetNames.length) { showImpError("That file has no sheets we can read."); return; }
      state.imp = { fileName: f.name, wb, sheetNames: wb.SheetNames };
      const sel = $("#import-sheet"); sel.innerHTML = "";
      wb.SheetNames.forEach(n => sel.appendChild(new Option(n, n)));
      $("#import-file-name").textContent = f.name;
      impLoadSheet(wb.SheetNames[0]);
      showStep("config");
      $("#import-reset").hidden = false;
    } catch (e) {
      showImpError("Couldn't read that file: " + (e && e.message ? e.message : e));
    }
  }
  function showImpError(msg) { const b = $("#import-parse-error"); $("span", b).textContent = msg; b.hidden = false; showStep("upload"); }

  function impLoadSheet(name) {
    const ws = state.imp.wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
    state.imp.sheetName = name;
    state.imp.aoa = aoa;
    // guess a header row: first row within the first 5 that has >=2 non-empty short cells
    let headerRow = 0;
    for (let i = 0; i < Math.min(aoa.length, 6); i++) {
      const cells = (aoa[i] || []).filter(c => String(c).trim());
      if (cells.length >= 2) { headerRow = i; break; }
    }
    state.imp.headerRow = headerRow;
    const hsel = $("#import-headerrow"); hsel.innerHTML = "";
    for (let i = 0; i < Math.min(aoa.length, 15); i++) hsel.appendChild(new Option("Row " + (i + 1), i));
    hsel.value = String(headerRow);
    impRefreshColumns();
  }

  function impColumnLabels() {
    const { aoa, headerRow } = state.imp;
    const ncols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
    const header = aoa[headerRow] || [];
    const labels = [];
    for (let c = 0; c < ncols; c++) {
      const h = String(header[c] || "").trim();
      labels.push({ c, label: h ? `${colLetter(c)} · ${h.slice(0, 40)}` : `Column ${colLetter(c)}`, header: h });
    }
    return labels;
  }

  function impRefreshColumns() {
    const labels = impColumnLabels();
    const { aoa, headerRow } = state.imp;
    // guess question column: header matches keywords, else longest average text
    const qKey = /quest|require|item|descript|criteria|topic|ask/i;
    const aKey = /answer|response|reply|comment|supplier|vendor|bidder|remarks?/i;
    let qCol = labels.findIndex(l => qKey.test(l.header));
    if (qCol < 0) {
      let best = -1, bestLen = -1;
      labels.forEach(l => {
        let tot = 0, n = 0;
        for (let i = headerRow + 1; i < aoa.length; i++) { const v = String((aoa[i] || [])[l.c] || ""); if (v) { tot += v.length; n++; } }
        const avg = n ? tot / n : 0;
        if (avg > bestLen) { bestLen = avg; best = l.c; }
      });
      qCol = best < 0 ? 0 : best;
    }
    let aCol = labels.findIndex(l => aKey.test(l.header));

    const qsel = $("#import-qcol"); qsel.innerHTML = "";
    labels.forEach(l => qsel.appendChild(new Option(l.label, l.c)));
    qsel.value = String(qCol);

    const asel = $("#import-acol"); asel.innerHTML = "";
    asel.appendChild(new Option("➕ New column at the end", "-1"));
    labels.forEach(l => asel.appendChild(new Option(l.label, l.c)));
    asel.value = String(aCol >= 0 ? aCol : -1);

    state.imp.qCol = qCol;
    state.imp.aCol = aCol >= 0 ? aCol : -1;
    qsel.onchange = () => { state.imp.qCol = parseInt(qsel.value, 10); renderImportPreview(); };
    asel.onchange = () => { state.imp.aCol = parseInt(asel.value, 10); };
    renderImportPreview();
  }

  function renderImportPreview() {
    const { aoa, headerRow, qCol } = state.imp;
    const tb = $("#import-preview"); tb.innerHTML = "";
    let shown = 0, total = 0;
    for (let i = headerRow + 1; i < aoa.length && shown < 4; i++) {
      const v = String((aoa[i] || [])[qCol] || "").trim();
      if (!v) continue;
      shown++;
      const tr = el("tr");
      tr.innerHTML = `<td class="text-secondary text-sm" style="width:2.5rem">${i + 1}</td><td class="text-sm">${esc(v.slice(0, 140))}</td>`;
      tb.appendChild(tr);
    }
    for (let i = headerRow + 1; i < aoa.length; i++) { if (String((aoa[i] || [])[qCol] || "").trim()) total++; }
    $("#import-config-hint").textContent = total
      ? `${total} question${total === 1 ? "" : "s"} detected in column ${colLetter(qCol)}. Preview below — adjust the column if that's not right.`
      : "No questions detected in that column — try a different one.";
  }

  function impRun() {
    const { aoa, headerRow, qCol, aCol } = state.imp;
    const index = RFPMatch.buildIndex(state.questions, q => q.question);
    const byId = {}; state.questions.forEach(q => byId[q.id] = q);
    const rows = [];
    for (let i = headerRow + 1; i < aoa.length; i++) {
      const qtext = String((aoa[i] || [])[qCol] || "").trim();
      if (!qtext) continue;
      const cands = RFPMatch.match(qtext, index, 4);
      const top = cands[0] || null;
      const band = top ? RFPMatch.band(top.score) : "gap";
      const chosen = band === "gap" ? null : top.q;
      rows.push({
        seq: rows.length + 1,
        rowIdx: i,
        question: qtext,
        sourceAnswer: aCol >= 0 ? String((aoa[i] || [])[aCol] || "").trim() : "",
        cands,
        band,
        chosenId: chosen ? chosen.id : null,
        answer: chosen ? (chosen.answer || "") : "",
        overridden: false,
        include: band !== "gap" && !!(chosen && chosen.answer),
        addedId: null
      });
    }
    state.imp.rows = rows;
    state.imp.byId = byId;
    showStep("review");
    renderImportStats();
    renderImportRows();
  }

  function renderImportStats() {
    const rows = state.imp.rows;
    $("#imp-stat-total").textContent = rows.length;
    $("#imp-stat-strong").textContent = rows.filter(r => r.band === "strong").length;
    $("#imp-stat-partial").textContent = rows.filter(r => r.band === "partial").length;
    $("#imp-stat-gap").textContent = rows.filter(r => r.band === "gap").length;
    const inc = rows.filter(r => r.include && r.answer).length;
    const gaps = rows.filter(r => r.band === "gap" && !r.addedId).length;
    $("#import-action-summary").textContent = `${inc} of ${rows.length} answers ready to export`;
    $("#import-action-sub").textContent = gaps ? `${gaps} gap${gaps === 1 ? "" : "s"} with no knowledge-base answer.` : "Every question has a drafted answer.";
    const pushBtn = $("#import-pushkb");
    if (isEditor() && gaps) { pushBtn.hidden = false; pushBtn.innerHTML = `<i class="fa-solid fa-database"></i> Add ${gaps} gap${gaps === 1 ? "" : "s"} to knowledge base`; }
    else pushBtn.hidden = true;
  }

  function renderImportRows() {
    const rows = state.imp.rows;
    const q = $("#import-search").value.trim().toLowerCase();
    const bf = $("#import-filter-band").value;
    const tb = $("#import-rows"); tb.innerHTML = "";
    let shown = 0;
    rows.forEach(r => {
      if (bf === "included") { if (!(r.include && r.answer)) return; }
      else if (bf && r.band !== bf) return;
      if (q && !(r.question.toLowerCase().includes(q) || (r.chosenId || "").toLowerCase().includes(q))) return;
      shown++;
      const chosen = r.chosenId ? state.imp.byId[r.chosenId] : null;
      const b = IMP_BAND[r.band];

      // match cell: badge + selector of candidates + gap option
      const opts = r.cands.map(c => {
        const cb = IMP_BAND[RFPMatch.band(c.score)];
        return `<option value="${esc(c.q.id)}" ${c.q.id === r.chosenId ? "selected" : ""}>${esc(c.q.id)} · ${cb.label} (${Math.round(c.score * 100)}%) — ${esc(c.q.question.slice(0, 50))}</option>`;
      }).join("");
      const gapSel = `<option value="" ${!r.chosenId ? "selected" : ""}>— No match (gap) —</option>`;

      const tr = el("tr");
      tr.className = r.addedId ? "rfp-imp-added" : "";
      tr.innerHTML =
        `<td class="text-secondary text-sm">${r.seq}</td>` +
        `<td class="rfp-imp-q"><div>${esc(r.question.slice(0, 220))}</div>${r.sourceAnswer ? `<small class="text-secondary">Their note: ${esc(r.sourceAnswer.slice(0, 90))}</small>` : ""}</td>` +
        `<td class="rfp-imp-match">` +
          `<div class="cluster cluster-sm" style="margin-bottom:var(--space-2xs)"><span class="badge ${b.cls} badge-sm">${b.label}</span>` +
          (chosen ? `<a href="#" class="text-sm rfp-imp-view" data-view="${esc(chosen.id)}">${esc(chosen.id)} <i class="fa-solid fa-arrow-up-right-from-square fa-xs"></i></a>` : (r.addedId ? `<span class="badge badge-brand badge-sm">Added ${esc(r.addedId)}</span>` : "")) +
          `</div>` +
          `<select class="select select-sm rfp-imp-sel">${opts}${gapSel}</select>` +
        `</td>` +
        `<td class="rfp-imp-ans"><textarea class="textarea rfp-imp-ta" rows="3" placeholder="${r.band === "gap" ? "No match — write an answer or leave for a DRI." : "Answer from the knowledge base…"}">${esc(r.answer)}</textarea>${r.overridden ? `<small class="text-secondary">Edited from KB answer</small>` : ""}</td>` +
        `<td class="text-center"><label class="check"><input type="checkbox" class="rfp-imp-inc" ${r.include ? "checked" : ""}></label></td>`;

      // wire per-row controls
      const sel = $(".rfp-imp-sel", tr);
      sel.addEventListener("change", () => {
        r.chosenId = sel.value || null;
        r.band = r.chosenId ? RFPMatch.band((r.cands.find(c => c.q.id === r.chosenId) || {}).score || 0) : "gap";
        if (!r.overridden) { const kb = r.chosenId ? state.imp.byId[r.chosenId] : null; r.answer = kb ? (kb.answer || "") : ""; }
        r.include = !!(r.chosenId && r.answer) ? true : r.include;
        renderImportStats(); renderImportRows();
      });
      const ta = $(".rfp-imp-ta", tr);
      ta.addEventListener("input", () => { r.answer = ta.value; r.overridden = true; });
      ta.addEventListener("blur", renderImportStats);
      const inc = $(".rfp-imp-inc", tr);
      inc.addEventListener("change", () => { r.include = inc.checked; renderImportStats(); });
      const view = $(".rfp-imp-view", tr);
      if (view) view.addEventListener("click", e => { e.preventDefault(); const row = state.questions.find(x => x.id === view.dataset.view); if (row) openDrawer(row); });

      tb.appendChild(tr);
    });
    $("#import-summary").textContent = `${state.imp.fileName} — ${shown} shown of ${rows.length} questions.`;
  }

  function impDownload() {
    const { wb, sheetName, aoa, headerRow, rows } = state.imp;
    let writeCol = state.imp.aCol;
    const ws = wb.Sheets[sheetName];
    const ncols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
    if (writeCol < 0) {
      writeCol = ncols;
      XLSX.utils.sheet_add_aoa(ws, [["Cloudstaff Response"]], { origin: { r: headerRow, c: writeCol } });
    }
    let written = 0;
    rows.forEach(r => {
      if (r.include && r.answer) { XLSX.utils.sheet_add_aoa(ws, [[r.answer]], { origin: { r: r.rowIdx, c: writeCol } }); written++; }
    });
    // make sure the sheet range covers the new column
    const ref = XLSX.utils.decode_range(ws["!ref"]);
    if (writeCol > ref.e.c) { ref.e.c = writeCol; ws["!ref"] = XLSX.utils.encode_range(ref); }
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const base = state.imp.fileName.replace(/\.(xlsx|xls|xlsm|csv)$/i, "");
    downloadBlob(new Blob([out], { type: "application/octet-stream" }), `${base} — Cloudstaff responses.xlsx`);
    toast(`Filled ${written} answer${written === 1 ? "" : "s"} into ${colLetter(writeCol)}`);
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ---- write new (gap) questions back into the knowledge base -------------
  function openKbModal() {
    if (!isEditor()) return;
    const gaps = state.imp.rows.filter(r => r.band === "gap" && !r.addedId);
    if (!gaps.length) return;
    const cats = isAdmin() ? state.categories : state.categories.filter(c => state.myCategoryIds.has(c.id));
    const body = $("#kb-body");
    if (!cats.length) {
      body.innerHTML = `<div class="alert alert-warning"><i class="alert-icon fa-solid fa-user-shield"></i><span>You're not a DRI for any category, so you can't add questions. Ask an admin to assign you, or add them from an admin account.</span></div>`;
      $("#kb-save").disabled = true;
      openOverlay("#kb-overlay"); return;
    }
    $("#kb-save").disabled = false;
    const catOpts = cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    body.innerHTML =
      `<p class="text-secondary text-sm">Assign a category and confirm the wording for each new question. New questions are saved for DRI review (they won't overwrite anything). ${isAdmin() ? "" : "You can only file into categories you own."}</p>` +
      gaps.map((r, i) => `
        <div class="rfp-kb-item card" data-kb-row="${r.seq}">
          <label class="check" style="margin-bottom:var(--space-xs)"><input type="checkbox" class="kb-inc" checked> <strong>Q${r.seq}</strong></label>
          <div class="field"><label class="field-label">Question</label><textarea class="textarea kb-q" rows="2">${esc(r.question)}</textarea></div>
          <div class="cluster cluster-sm">
            <div class="field flex-1"><label class="field-label">Category</label><select class="select kb-cat">${catOpts}</select></div>
            <div class="field"><label class="field-label">Tier</label><select class="select kb-tier"><option>Client</option><option>Internal</option></select></div>
          </div>
          <div class="field"><label class="field-label">Answer (optional)</label><textarea class="textarea kb-a" rows="2" placeholder="Leave blank to write later.">${esc(r.answer)}</textarea></div>
        </div>`).join("");
    $("#kb-error").hidden = true;
    openOverlay("#kb-overlay");
  }
  function openOverlay(sel) { $(sel).hidden = false; document.body.style.overflow = "hidden"; }
  function closeKbModal() { $("#kb-overlay").hidden = true; document.body.style.overflow = ""; }

  async function saveKbQuestions() {
    const err = $("#kb-error"); err.hidden = true;
    const items = $$("#kb-body [data-kb-row]").filter(n => $(".kb-inc", n).checked);
    if (!items.length) { err.textContent = "Nothing selected."; err.hidden = false; return; }
    const btn = $("#kb-save"); btn.classList.add("is-loading"); btn.disabled = true;
    const stamp = new Date().toISOString().slice(0, 10);
    const src = `Imported from ${state.imp.fileName} · ${stamp}`;
    let ok = 0, fail = 0;
    for (const node of items) {
      const seq = parseInt(node.dataset.kbRow, 10);
      const row = state.imp.rows.find(r => r.seq === seq);
      const catId = parseInt($(".kb-cat", node).value, 10);
      const question = $(".kb-q", node).value.trim();
      const tier = $(".kb-tier", node).value;
      const answer = $(".kb-a", node).value.trim() || null;
      if (!question || !catId) { fail++; continue; }
      const status = answer ? "edit-pending" : "approved-blank";
      const id = nextIdForCategory(catId);
      const q1 = await state.sb.from("canonical_questions").insert({ id, category_id: catId, question, tier, status, needs_rework: !!answer, sample_only: false });
      if (q1.error) { fail++; continue; }
      await state.sb.from("canonical_answers").insert({ question_id: id, answer, answer_source: src, updated_by: state.user.id });
      await state.sb.from("answer_versions").insert({ question_id: id, answer, answer_source: src, note: `Imported from ${state.imp.fileName} (row ${row ? row.rowIdx + 1 : "?"}) by ${state.profile.email}`, created_by: state.user.id });
      if (row) { row.addedId = id; row.band = "partial"; row.chosenId = id; }
      // keep local list roughly current so nextIdForCategory increments
      state.questions.push({ id, category: (state.categories.find(c => c.id === catId) || {}).name, tier, status, question, answer, needs_rework: !!answer });
      ok++;
    }
    btn.classList.remove("is-loading"); btn.disabled = false;
    closeKbModal();
    await loadQuestions();
    toast(ok ? `Added ${ok} question${ok === 1 ? "" : "s"} to the knowledge base${fail ? ` (${fail} skipped)` : ""}` : "Nothing added", ok ? "success" : "danger");
    renderImportStats(); renderImportRows();
  }
})();
