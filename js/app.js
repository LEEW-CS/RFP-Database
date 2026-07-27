/* ==========================================================================
   Cloudstaff RFP Builder — Phase 2 front-end
   Q&A Browser · My Attestations · in-app editing (edit / add / soft-delete)
   Plain vanilla JS + supabase-js. No build step.
   ========================================================================== */
(function () {
  "use strict";

  const APP_VERSION = "v0.11.0";

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
    imp: null,          // New-RFP import session (see import module below)
    profilesAll: [],    // all profiles (names for assignment display)
    drisAll: [],        // full category_dris mapping (for default assignees)
    rfps: [],           // response projects (list view)
    rfpsAgg: {},        // rfp_id -> {total, done}
    currentRfp: null,   // open response project
    currentRfpRows: [], // its rows
    rfpTodos: [],       // pending rfp_rows assigned to me
    approveRow: null,   // row open in the approve modal
    currentHistory: null, currentHistoryRows: [],   // RFP History detail
    resSection: null,   // section being added to in the Library modal
    resEditing: null,   // resource open in the edit modal (null = adding new)
    resDeleting: null, resDeleteBound: [],  // admin delete-asset modal
    userEditing: null,                       // profile open in the user modal (null = adding)
    userDeleting: null, userOwned: null      // admin delete-user modal
  };

  const isAdmin = () => (state.profile && state.profile.role === "admin");
  const isEditor = () => (state.profile && (state.profile.role === "admin" || state.profile.role === "editor"));
  const catIdByName = (name) => { const c = state.categories.find(c => c.name === name); return c ? c.id : -1; };
  const canEdit = (row) => isAdmin() || state.myCategoryIds.has(catIdByName(row.category));
  const nameOf = (uid) => { const p = state.profilesAll.find(p => p.user_id === uid); return p ? (p.full_name || p.email) : "—"; };
  const editorProfiles = () => state.profilesAll.filter(p => p.role === "admin" || p.role === "editor");
  function primaryDriForCategoryId(catId) {
    const rows = state.drisAll.filter(d => d.category_id === catId);
    const primary = rows.find(d => d.is_primary) || rows[0];
    return primary ? primary.user_id : null;
  }

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
    $$("[data-create-close]").forEach(b => b.addEventListener("click", closeCreateModal));
    $$("[data-approve-close]").forEach(b => b.addEventListener("click", closeApproveModal));
    document.addEventListener("keydown", e => { if (e.key === "Escape") { closeDrawer(); closeNewQ(); closeCreateModal(); closeApproveModal(); } });
    $$("[data-nav]").forEach(a => a.addEventListener("click", () => {
      if (a.dataset.nav === "rfps") state.currentRfp = null;      // nav always returns to the list
      setTimeout(route, 0);
    }));
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
    const [cats, profAll, drisAll, res, prov, att] = await Promise.all([
      sb.from("categories").select("id,code,name,sort_order").order("sort_order"),
      sb.from("profiles").select("user_id,email,full_name,role"),
      sb.from("category_dris").select("category_id,user_id,is_primary"),
      sb.from("resources").select("*"),
      sb.from("provenance").select("question_id").range(0, 5000),
      sb.from("attestations").select("question_id,user_id,outcome,attested_at").order("attested_at", { ascending: false }).range(0, 5000)
    ]);
    state.categories = cats.data || [];
    state.profilesAll = profAll.data || [];
    state.profile = state.profilesAll.find(p => p.user_id === user.id) || { user_id: user.id, email: user.email, full_name: user.email, role: "viewer" };
    state.drisAll = drisAll.data || [];
    state.myCategoryIds = new Set(state.drisAll.filter(d => d.user_id === user.id).map(d => d.category_id));
    state.resources = res.data || [];
    state.provCounts = {};
    (prov.data || []).forEach(r => { state.provCounts[r.question_id] = (state.provCounts[r.question_id] || 0) + 1; });
    state.latestAttest = {};      // latest by ME (drives My To Do)
    state.latestAttestAny = {};   // latest by ANYONE (drives the Team Board)
    (att.data || []).forEach(a => {
      if (a.user_id === user.id && !state.latestAttest[a.question_id]) state.latestAttest[a.question_id] = a;
      if (!state.latestAttestAny[a.question_id]) state.latestAttestAny[a.question_id] = a;
    });
    await Promise.all([loadQuestions(), loadRfpTodos()]);
    renderUserBox(); populateCategoryFilter(); populateNewQCats(); route();
  }

  async function loadRfpTodos() {
    const { data } = await state.sb.from("rfp_rows")
      .select("id,rfp_id,seq,question,band,answer,include,matched_qid,rfps(name,status)")
      .eq("assigned_to", state.user.id).eq("status", "pending");
    state.rfpTodos = (data || []).filter(r => !r.rfps || r.rfps.status !== "finalised");
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
    const todo = ownedQuestions().filter(q => todoFor(q).rank < 3).length + state.rfpTodos.length;
    const nav = $("#attest-nav-count");
    if (todo) { nav.textContent = todo; nav.hidden = false; } else nav.hidden = true;
    $("#new-q-btn").hidden = !isEditor();
    $("#admin-nav").hidden = !isAdmin();
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
    else if (hash.includes("rfps")) view = "rfps";
    else if (hash.includes("history")) view = "history";
    else if (hash.includes("library")) view = "library";
    else if (hash.includes("board")) view = "board";
    else if (hash.includes("admin")) view = isAdmin() ? "admin" : "browser";
    $("#browser-view").hidden = view !== "browser";
    $("#attest-view").hidden = view !== "attest";
    $("#import-view").hidden = view !== "import";
    $("#rfps-view").hidden = view !== "rfps";
    $("#history-view").hidden = view !== "history";
    $("#library-view").hidden = view !== "library";
    $("#board-view").hidden = view !== "board";
    $("#admin-view").hidden = view !== "admin";
    $$("[data-nav]").forEach(a => a.classList.toggle("is-active", a.dataset.nav === view));
    if (view === "browser") renderBrowser();
    else if (view === "attest") renderAttest();
    else if (view === "rfps") renderRfps();
    else if (view === "history") renderHistory();
    else if (view === "library") renderLibrary();
    else if (view === "board") renderBoard();
    else if (view === "admin") renderAdmin();
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

    const assetsBlock = `
      <div class="stack-sm">
        <div class="cluster" style="justify-content:space-between">
          <h4>Attached assets <span class="badge badge-neutral badge-sm" id="qa-asset-count">–</span></h4>
          ${isEditor() ? `<button class="button button-secondary button-sm" id="qa-asset-add-btn"><i class="fa-solid fa-paperclip"></i> Add assets</button>` : ""}
        </div>
        <div id="qa-assets"><span class="spinner spinner--sm" role="status" aria-label="Loading"></span></div>
        <div id="qa-asset-picker" class="cluster cluster-sm" hidden>
          <select class="select select-sm" id="qa-asset-cat" style="max-width:12rem"><option value="">— Category —</option></select>
          <select class="select select-sm flex-1" id="qa-asset-item" disabled><option value="">— Pick an asset —</option></select>
          <button class="button button-primary button-sm" id="qa-asset-confirm" disabled><i class="fa-solid fa-plus"></i> Attach</button>
        </div>
      </div>`;

    body.innerHTML =
      `<div class="stack-2xs"><h3>${esc(row.question)}</h3><span class="text-secondary">${esc(row.category)}</span></div>` +
      attestBlock + answerArea + assetsBlock + metaBlock + resBlock +
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
    wireAssetPicker(row);
    loadQuestionAssets(row);
    if (!editing) loadProvenance(row.id);
  }

  // ---- attached assets (Library items bound to a question) ----------------
  async function loadQuestionAssets(row) {
    const box = $("#qa-assets"); if (!box) return;
    const [qr, res] = await Promise.all([
      state.sb.from("question_resources").select("resource_id").eq("question_id", row.id),
      state.sb.from("resources").select("*")
    ]);
    if (!$("#qa-assets")) return;                    // drawer re-rendered meanwhile
    state.resources = res.data || state.resources;
    const bound = (qr.data || []).map(x => state.resources.find(r => r.id === x.resource_id)).filter(Boolean);
    $("#qa-asset-count").textContent = bound.length;
    if (!bound.length) { box.innerHTML = `<p class="text-secondary text-sm">No assets attached yet.</p>`; return; }
    box.innerHTML = "";
    bound.forEach(r => {
      const item = el("div", "cluster cluster-sm rfp-qa-asset");
      item.innerHTML =
        `<i class="fa-solid ${LIB_ICON[r.section] || "fa-paperclip"} text-secondary"></i>` +
        `<span class="flex-1"><strong class="text-sm">${esc(r.name)}</strong> <span class="badge badge-neutral badge-sm">${esc(r.section || "—")}</span></span>`;
      if (r.url) { const a = el("a", "button button-tertiary button-sm", '<i class="fa-solid fa-arrow-up-right-from-square"></i>'); a.href = r.url; a.target = "_blank"; a.rel = "noopener"; item.appendChild(a); }
      if (r.file_ref) {
        const dl = el("button", "button button-tertiary button-sm", '<i class="fa-solid fa-download"></i>');
        dl.addEventListener("click", async () => {
          const { data, error } = await state.sb.storage.from("library").createSignedUrl(r.file_ref, 3600);
          if (error) return toast(error.message, "danger");
          const a = el("a"); a.href = data.signedUrl; a.target = "_blank"; a.rel = "noopener";
          document.body.appendChild(a); a.click(); a.remove();
        });
        item.appendChild(dl);
      }
      if (isEditor()) {
        const rm = el("button", "button button-tertiary button-sm", '<i class="fa-solid fa-xmark"></i>');
        rm.title = "Detach from this question";
        rm.addEventListener("click", async () => {
          const { error } = await state.sb.from("question_resources").delete().eq("question_id", row.id).eq("resource_id", r.id);
          if (error) return toast(error.message, "danger");
          toast("Asset detached");
          loadQuestionAssets(row);
        });
        item.appendChild(rm);
      }
      box.appendChild(item);
    });
  }

  function wireAssetPicker(row) {
    const btn = $("#qa-asset-add-btn"); if (!btn) return;
    const picker = $("#qa-asset-picker"), catSel = $("#qa-asset-cat"), itemSel = $("#qa-asset-item"), confirmBtn = $("#qa-asset-confirm");
    btn.addEventListener("click", () => {
      picker.hidden = !picker.hidden;
      if (!picker.hidden) {
        catSel.innerHTML = `<option value="">— Category —</option>`;
        LIB_SECTIONS.forEach(sec => {
          const n = state.resources.filter(r => (r.section || "Certifications") === sec).length;
          if (n) catSel.appendChild(new Option(`${sec} (${n})`, sec));
        });
        itemSel.innerHTML = `<option value="">— Pick an asset —</option>`; itemSel.disabled = true; confirmBtn.disabled = true;
      }
    });
    catSel.addEventListener("change", async () => {
      const sec = catSel.value;
      itemSel.innerHTML = `<option value="">— Pick an asset —</option>`;
      itemSel.disabled = !sec; confirmBtn.disabled = true;
      if (!sec) return;
      const { data: qr } = await state.sb.from("question_resources").select("resource_id").eq("question_id", row.id);
      const boundIds = new Set((qr || []).map(x => x.resource_id));
      state.resources.filter(r => (r.section || "Certifications") === sec && !boundIds.has(r.id))
        .forEach(r => itemSel.appendChild(new Option(r.name, r.id)));
    });
    itemSel.addEventListener("change", () => { confirmBtn.disabled = !itemSel.value; });
    confirmBtn.addEventListener("click", async () => {
      if (!itemSel.value) return;
      const { error } = await state.sb.from("question_resources").insert({ question_id: row.id, resource_id: itemSel.value });
      if (error) return toast(error.message, "danger");
      toast("Asset attached");
      picker.hidden = true;
      loadQuestionAssets(row);
    });
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
    $("#attest-not-dri").hidden = owned.length > 0 || state.rfpTodos.length > 0;
    $("#attest-table-wrap").hidden = owned.length === 0;
    renderAttestRfpTodos();
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

  function renderAttestRfpTodos() {
    const wrap = $("#attest-rfp-wrap");
    wrap.hidden = state.rfpTodos.length === 0;
    if (!state.rfpTodos.length) return;
    const tb = $("#attest-rfp-rows"); tb.innerHTML = "";
    state.rfpTodos.forEach(t => {
      const b = IMP_BAND[t.band] || IMP_BAND.gap;
      const tr = el("tr");
      tr.innerHTML =
        `<td class="text-sm"><strong>${esc(t.rfps ? t.rfps.name : "RFP")}</strong></td>` +
        `<td class="rfp-qa-q">${esc(t.question.slice(0, 160))}</td>` +
        `<td><span class="badge ${b.cls} badge-sm">${b.label}</span></td>` +
        `<td class="text-right"></td>`;
      const btn = el("button", "button button-primary button-sm", '<i class="fa-solid fa-pen"></i> Review');
      btn.addEventListener("click", async () => {
        location.hash = "#/rfps";
        await openRfp(t.rfp_id);
        const row = state.currentRfpRows.find(r => r.id === t.id);
        if (row) openApproveModal(row);
      });
      tr.lastChild.appendChild(btn);
      tb.appendChild(tr);
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
    $("#import-create").addEventListener("click", openCreateModal);
    $("#create-save").addEventListener("click", saveCreateProject);
    $("#approve-save").addEventListener("click", saveApprove);
    $("#approve-addkb").addEventListener("change", () => { $("#approve-kb-fields").hidden = !$("#approve-addkb").checked; });
    $("#rfp-back").addEventListener("click", () => { state.currentRfp = null; renderRfps(); });
    $("#history-select").addEventListener("change", () => openHistory($("#history-select").value));
    $("#history-sort").addEventListener("change", () => renderHistory());
    $("#history-export").addEventListener("click", exportHistoryExcel);
    $$("[data-res-close]").forEach(b => b.addEventListener("click", closeResModal));
    $("#res-save").addEventListener("click", saveResource);
    $$("[data-resdel-close]").forEach(b => b.addEventListener("click", closeResDeleteModal));
    $("#user-add-btn").addEventListener("click", () => openUserModal(null));
    $$("[data-user-close]").forEach(b => b.addEventListener("click", closeUserModal));
    $("#user-save").addEventListener("click", saveUser);
    $$("[data-userdel-close]").forEach(b => b.addEventListener("click", closeUserDeleteModal));
    $("#userdel-transfer").addEventListener("click", transferUserOwnership);
    $("#userdel-confirm").addEventListener("click", confirmUserDelete);
    $("#resdel-transfer").addEventListener("click", transferAssetBindings);
    $("#resdel-confirm").addEventListener("click", confirmAssetDelete);
    $("#rfp-finalise").addEventListener("click", finaliseRfp);
    $("#rfp-download-final").addEventListener("click", downloadFinal);
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
      state.imp = { fileName: f.name, buf, wb, sheetNames: wb.SheetNames };
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
        include: true,           // gaps included by default — a DRI writes the answer
        addedId: null
      });
    }
    state.imp.rows = rows;
    state.imp.byId = byId;
    showStep("review");
    renderImportStats();
    renderImportRows();
  }

  // A row is auto-approved when it is a strong match whose KB answer is used
  // untouched. Everything else that's included needs a DRI to approve it.
  const rowIsAuto = (r) => r.band === "strong" && !!r.answer && !r.overridden;

  function renderImportStats() {
    const rows = state.imp.rows;
    $("#imp-stat-total").textContent = rows.length;
    $("#imp-stat-strong").textContent = rows.filter(r => r.band === "strong").length;
    $("#imp-stat-partial").textContent = rows.filter(r => r.band === "partial").length;
    $("#imp-stat-gap").textContent = rows.filter(r => r.band === "gap").length;
    const included = rows.filter(r => r.include);
    const auto = included.filter(rowIsAuto).length;
    const need = included.length - auto;
    $("#import-action-summary").textContent = `${auto} answer${auto === 1 ? "" : "s"} auto-approved · ${need} need${need === 1 ? "s" : ""} DRI review`;
    $("#import-action-sub").textContent = "Create a response project to assign DRIs. The response document can be produced once every answer is approved.";
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

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function openOverlay(sel) { $(sel).hidden = false; document.body.style.overflow = "hidden"; }

  /* ========================================================================
     RESPONSE PROJECTS — create → DRI approval → finalise (v0.6.0)
     ======================================================================== */
  const RFP_STATUS = {
    auto:     { cls: "badge-success", label: "Auto-approved" },
    pending:  { cls: "badge-warning", label: "Awaiting DRI" },
    approved: { cls: "badge-success", label: "Approved" }
  };

  // ---- create project from the current import session ---------------------
  function pendingImportRows() {
    return state.imp.rows.filter(r => r.include && !rowIsAuto(r));
  }

  function defaultAssignee(r) {
    if (!r.chosenId) return "";                       // gap — uploader must pick
    const kb = state.imp.byId[r.chosenId];
    if (!kb) return "";
    const uid = primaryDriForCategoryId(catIdByName(kb.category));
    return uid || "";
  }

  function openCreateModal() {
    if (!state.imp || !state.imp.rows) return;
    const pending = pendingImportRows();
    const auto = state.imp.rows.filter(r => r.include && rowIsAuto(r)).length;
    $("#create-name").value = state.imp.fileName.replace(/\.(xlsx|xls|xlsm|csv)$/i, "");
    $("span", $("#create-auto-note")).textContent =
      `${auto} strong match${auto === 1 ? "" : "es"} to approved knowledge-base answers will be auto-approved.`;
    const editors = editorProfiles();
    const opts = (selId) => `<option value="">— Choose a DRI —</option>` +
      editors.map(p => `<option value="${p.user_id}" ${p.user_id === selId ? "selected" : ""}>${esc(p.full_name || p.email)}</option>`).join("");
    const list = $("#create-assign-list");
    if (!pending.length) {
      list.innerHTML = `<div class="alert alert-success banner-inline"><i class="alert-icon fa-solid fa-circle-check"></i><span>Nothing needs review — every included answer is a strong match. You can finalise right after creating.</span></div>`;
    } else {
      list.innerHTML = pending.map(r => {
        const b = IMP_BAND[r.band];
        return `<div class="rfp-kb-item card" data-assign-row="${r.seq}">
          <div class="cluster" style="justify-content:space-between">
            <span><strong>Q${r.seq}</strong> <span class="badge ${b.cls} badge-sm">${b.label}</span>${r.overridden ? ' <span class="badge badge-info badge-sm">Edited</span>' : ""}</span>
          </div>
          <p class="text-sm rfp-assign-q">${esc(r.question.slice(0, 180))}</p>
          <div class="field"><label class="field-label">DRI</label>
            <select class="select assign-sel">${opts(defaultAssignee(r))}</select></div>
        </div>`;
      }).join("");
    }
    $("#create-error").hidden = true;
    openOverlay("#create-overlay");
  }
  function closeCreateModal() { $("#create-overlay").hidden = true; document.body.style.overflow = ""; }

  async function saveCreateProject() {
    const err = $("#create-error"); err.hidden = true;
    const name = $("#create-name").value.trim();
    if (!name) { err.textContent = "Give the project a name."; err.hidden = false; return; }
    const nodes = $$("#create-assign-list [data-assign-row]");
    const assignments = {};
    for (const n of nodes) {
      const uid = $(".assign-sel", n).value;
      if (!uid) { err.textContent = "Every question that needs review must have a DRI assigned."; err.hidden = false; return; }
      assignments[parseInt(n.dataset.assignRow, 10)] = uid;
    }
    const btn = $("#create-save"); btn.classList.add("is-loading"); btn.disabled = true;

    const rfpId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2));
    const safeName = state.imp.fileName.replace(/[^\w.\- ]+/g, "_");
    const storagePath = `${rfpId}/${safeName}`;

    // 1) original workbook into Storage so finalise can rebuild it later
    const up = await state.sb.storage.from("rfps").upload(storagePath,
      new Blob([state.imp.buf], { type: "application/octet-stream" }), { upsert: true });
    if (up.error) { btn.classList.remove("is-loading"); btn.disabled = false; err.textContent = "Upload failed: " + up.error.message; err.hidden = false; return; }

    // 2) project row
    const proj = {
      id: rfpId, name, file_name: state.imp.fileName, storage_path: storagePath,
      sheet_name: state.imp.sheetName, header_row: state.imp.headerRow,
      q_col: state.imp.qCol, a_col: state.imp.aCol, created_by: state.user.id
    };
    const r1 = await state.sb.from("rfps").insert(proj);
    if (r1.error) { btn.classList.remove("is-loading"); btn.disabled = false; err.textContent = r1.error.message; err.hidden = false; return; }

    // 3) question rows
    const rowsIns = state.imp.rows.map(r => {
      const auto = r.include && rowIsAuto(r);
      const top = r.chosenId ? (r.cands.find(c => c.q.id === r.chosenId) || null) : null;
      return {
        rfp_id: rfpId, seq: r.seq, row_idx: r.rowIdx, question: r.question,
        matched_qid: r.chosenId, score: top ? Math.round(top.score * 1000) / 1000 : null,
        band: r.band, answer: r.answer || null, include: r.include,
        status: r.include ? (auto ? "auto" : "pending") : "auto",
        assigned_to: (r.include && !auto) ? (assignments[r.seq] || null) : null
      };
    });
    const r2 = await state.sb.from("rfp_rows").insert(rowsIns);
    btn.classList.remove("is-loading"); btn.disabled = false;
    if (r2.error) { err.textContent = r2.error.message; err.hidden = false; return; }

    closeCreateModal();
    toast(`Response project "${name}" created`);
    resetImport();
    state.rfps = [];              // force list reload
    await loadRfpTodos(); renderUserBox();
    location.hash = "#/rfps";
    await openRfp(rfpId);
  }

  // ---- list & detail ------------------------------------------------------
  async function renderRfps() {
    $("#rfps-list-wrap").hidden = !!state.currentRfp;
    $("#rfp-detail-wrap").hidden = !state.currentRfp;
    if (state.currentRfp) { renderRfpDetail(); return; }
    const [ps, rs] = await Promise.all([
      state.sb.from("rfps").select("*").order("created_at", { ascending: false }),
      state.sb.from("rfp_rows").select("rfp_id,status,include")
    ]);
    state.rfps = ps.data || [];
    state.rfpsAgg = {};
    (rs.data || []).forEach(r => {
      const a = state.rfpsAgg[r.rfp_id] || (state.rfpsAgg[r.rfp_id] = { total: 0, done: 0 });
      if (!r.include) return;
      a.total++;
      if (r.status !== "pending") a.done++;
    });
    const tb = $("#rfps-rows"); tb.innerHTML = "";
    $("#rfps-empty").hidden = state.rfps.length > 0;
    state.rfps.forEach(p => {
      const a = state.rfpsAgg[p.id] || { total: 0, done: 0 };
      const fin = p.status === "finalised";
      const tr = el("tr");
      tr.innerHTML =
        `<td><strong>${esc(p.name)}</strong></td>` +
        `<td class="text-sm text-secondary">${esc(p.file_name)}</td>` +
        `<td class="text-sm">${fmtDate(p.created_at)}</td>` +
        `<td class="text-sm">${a.done} / ${a.total}${a.done === a.total ? ' <i class="fa-solid fa-circle-check text-sm" style="color:var(--color-success, #1a7f37)"></i>' : ""}</td>` +
        `<td><span class="badge ${fin ? "badge-success" : "badge-warning"} badge-sm">${fin ? "Finalised" : "In review"}</span></td>`;
      tr.addEventListener("click", () => openRfp(p.id));
      tb.appendChild(tr);
    });
    $("#rfps-summary").textContent = state.rfps.length
      ? `${state.rfps.length} response project${state.rfps.length === 1 ? "" : "s"}.`
      : "Response projects awaiting DRI approval, and finalised documents.";
  }

  async function openRfp(id) {
    const [p, rs] = await Promise.all([
      state.sb.from("rfps").select("*").eq("id", id).single(),
      state.sb.from("rfp_rows").select("*").eq("rfp_id", id).order("seq")
    ]);
    if (p.error) { toast(p.error.message, "danger"); return; }
    state.currentRfp = p.data;
    state.currentRfpRows = rs.data || [];
    location.hash = "#/rfps";
    $("#rfps-view").hidden = false;
    renderRfps();
  }

  function renderRfpDetail() {
    const p = state.currentRfp, rows = state.currentRfpRows;
    const included = rows.filter(r => r.include);
    const auto = included.filter(r => r.status === "auto").length;
    const approved = included.filter(r => r.status === "approved").length;
    const pending = included.filter(r => r.status === "pending").length;
    const fin = p.status === "finalised";
    const canManage = isAdmin() || p.created_by === state.user.id;

    $("#rfp-detail-name").textContent = p.name;
    $("#rfp-detail-sub").textContent = `${p.file_name} · uploaded ${fmtDate(p.created_at)} by ${nameOf(p.created_by)}` + (fin ? ` · finalised ${fmtDate(p.finalised_at)}` : "");
    $("#rfp-detail-status").innerHTML = `<span class="badge ${fin ? "badge-success" : "badge-warning"} badge-sm">${fin ? "Finalised" : "In review"}</span>`;
    $("#rfp-stat-total").textContent = included.length;
    $("#rfp-stat-auto").textContent = auto;
    $("#rfp-stat-approved").textContent = approved;
    $("#rfp-stat-pending").textContent = pending;
    $("#rfp-finalise").hidden = !(canManage && !fin && pending === 0 && included.length > 0);
    $("#rfp-download-final").hidden = !(fin && p.finalised_path);

    const tb = $("#rfp-detail-rows"); tb.innerHTML = "";
    rows.forEach(r => {
      const st = RFP_STATUS[r.status] || RFP_STATUS.pending;
      const b = IMP_BAND[r.band] || IMP_BAND.gap;
      const mine = r.assigned_to === state.user.id;
      const kbid = r.added_qid || r.matched_qid;
      const tr = el("tr");
      if (!r.include) tr.style.opacity = "0.5";
      tr.innerHTML =
        `<td class="text-secondary text-sm">${r.seq}</td>` +
        `<td class="rfp-imp-q">${esc(r.question.slice(0, 200))}${r.include ? "" : '<small class="text-secondary">Excluded from document</small>'}</td>` +
        `<td><span class="badge ${b.cls} badge-sm">${b.label}</span>${kbid ? `<div><a href="#" class="text-sm rfp-detail-view" data-view="${esc(kbid)}">${esc(kbid)}</a></div>` : ""}</td>` +
        `<td class="text-sm rfp-detail-ans">${esc((r.answer || "—").slice(0, 160))}</td>` +
        `<td class="text-sm">${r.assigned_to ? esc(nameOf(r.assigned_to)) : '<span class="text-secondary">—</span>'}</td>` +
        `<td class="text-right"></td>`;
      const cell = tr.lastChild;
      const actions = el("div", "cluster cluster-sm"); actions.style.justifyContent = "flex-end";
      if (r.status === "pending" && !fin && (mine || isAdmin())) {
        const btn = el("button", "button button-primary button-sm", '<i class="fa-solid fa-pen"></i> Review');
        btn.addEventListener("click", e => { e.stopPropagation(); openApproveModal(r); });
        actions.append(btn);
      } else {
        actions.append(el("span", `badge ${st.cls} badge-sm`, st.label));
      }
      cell.appendChild(actions);
      const view = $(".rfp-detail-view", tr);
      if (view) view.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); const q = state.questions.find(x => x.id === view.dataset.view); if (q) openDrawer(q); });
      tb.appendChild(tr);
    });
  }

  // ---- approve modal ------------------------------------------------------
  function openApproveModal(row) {
    state.approveRow = row;
    const b = IMP_BAND[row.band] || IMP_BAND.gap;
    $("#approve-question").textContent = row.question;
    $("#approve-matchinfo").innerHTML = row.matched_qid
      ? `Matched to <strong>${esc(row.matched_qid)}</strong> (${b.label.toLowerCase()}${row.score ? `, ${Math.round(row.score * 100)}%` : ""}). Edit the answer if needed, then approve.`
      : "No knowledge-base match — write the answer to send.";
    $("#approve-answer").value = row.answer || "";
    $("#approve-include").checked = !!row.include;
    // offer add-to-KB only for rows that aren't already tied to a KB question
    const kbBlock = $("#approve-kb-block");
    const cats = isAdmin() ? state.categories : state.categories.filter(c => state.myCategoryIds.has(c.id));
    if (!row.matched_qid && !row.added_qid && cats.length) {
      kbBlock.hidden = false;
      $("#approve-addkb").checked = false;
      $("#approve-kb-fields").hidden = true;
      const sel = $("#approve-kb-cat"); sel.innerHTML = "";
      cats.forEach(c => sel.appendChild(new Option(c.name, c.id)));
    } else kbBlock.hidden = true;
    $("#approve-error").hidden = true;
    openOverlay("#approve-overlay");
  }
  function closeApproveModal() { $("#approve-overlay").hidden = true; document.body.style.overflow = ""; state.approveRow = null; }

  async function saveApprove() {
    const row = state.approveRow; if (!row) return;
    const err = $("#approve-error"); err.hidden = true;
    const answer = $("#approve-answer").value.trim();
    const include = $("#approve-include").checked;
    if (include && !answer) { err.textContent = "Write the answer, or untick Include to leave this question out."; err.hidden = false; return; }
    const btn = $("#approve-save"); btn.classList.add("is-loading"); btn.disabled = true;

    let addedQid = row.added_qid || null;
    if (!$("#approve-kb-block").hidden && $("#approve-addkb").checked && answer) {
      const catId = parseInt($("#approve-kb-cat").value, 10);
      const tier = $("#approve-kb-tier").value;
      const id = nextIdForCategory(catId);
      const src = `RFP response · ${new Date().toISOString().slice(0, 10)}`;
      const q1 = await state.sb.from("canonical_questions").insert({ id, category_id: catId, question: row.question, tier, status: "approved", needs_rework: false, sample_only: false });
      if (q1.error) { btn.classList.remove("is-loading"); btn.disabled = false; err.textContent = q1.error.message; err.hidden = false; return; }
      await state.sb.from("canonical_answers").insert({ question_id: id, answer, answer_source: src, updated_by: state.user.id });
      await state.sb.from("answer_versions").insert({ question_id: id, answer, answer_source: src, note: `Approved in RFP response by ${state.profile.email}`, created_by: state.user.id });
      state.questions.push({ id, category: (state.categories.find(c => c.id === catId) || {}).name, tier, status: "approved", question: row.question, answer });
      addedQid = id;
    }

    const { error } = await state.sb.from("rfp_rows").update({
      answer: answer || null, include, status: "approved", added_qid: addedQid,
      approved_by: state.user.id, approved_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", row.id);
    btn.classList.remove("is-loading"); btn.disabled = false;
    if (error) { err.textContent = error.message; err.hidden = false; return; }

    closeApproveModal();
    toast(addedQid && addedQid !== row.added_qid ? `Approved — added ${addedQid} to the knowledge base` : "Answer approved");
    if (addedQid) await loadQuestions();
    await Promise.all([openRfp(row.rfp_id), loadRfpTodos()]);
    renderUserBox();
  }

  // ---- finalise -----------------------------------------------------------
  async function finaliseRfp() {
    const p = state.currentRfp; if (!p) return;
    const rows = state.currentRfpRows.filter(r => r.include && r.status !== "pending" && r.answer);
    if (!confirm(`Finalise "${p.name}"? This writes ${rows.length} approved answers into the response document and records provenance. It can't be re-opened.`)) return;
    const btn = $("#rfp-finalise"); btn.classList.add("is-loading"); btn.disabled = true;
    try {
      // 1) rebuild the workbook from the stored original
      const dl = await state.sb.storage.from("rfps").download(p.storage_path);
      if (dl.error) throw new Error("Couldn't fetch the original file: " + dl.error.message);
      const wb = XLSX.read(await dl.data.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets[p.sheet_name];
      if (!ws) throw new Error(`Sheet "${p.sheet_name}" not found in the stored file.`);
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
      let writeCol = p.a_col;
      if (writeCol == null || writeCol < 0) {
        writeCol = aoa.reduce((m, r) => Math.max(m, r.length), 0);
        XLSX.utils.sheet_add_aoa(ws, [["Cloudstaff Response"]], { origin: { r: p.header_row, c: writeCol } });
      }
      rows.forEach(r => XLSX.utils.sheet_add_aoa(ws, [[r.answer]], { origin: { r: r.row_idx, c: writeCol } }));
      const ref = XLSX.utils.decode_range(ws["!ref"]);
      if (writeCol > ref.e.c) { ref.e.c = writeCol; ws["!ref"] = XLSX.utils.encode_range(ref); }
      const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const base = p.file_name.replace(/\.(xlsx|xls|xlsm|csv)$/i, "");
      const outName = `${base} — Cloudstaff responses.xlsx`;

      // 2) store the finalised copy, then hand it to the user
      const finalPath = `${p.id}/final_${base.replace(/[^\w.\- ]+/g, "_")}.xlsx`;
      const up = await state.sb.storage.from("rfps").upload(finalPath,
        new Blob([out], { type: "application/octet-stream" }), { upsert: true });
      if (up.error) throw new Error("Couldn't store the finalised file: " + up.error.message);
      downloadBlob(new Blob([out], { type: "application/octet-stream" }), outName);

      // 3) provenance: record which answer served each question
      const provRows = rows.filter(r => r.added_qid || r.matched_qid).map(r => ({
        question_id: r.added_qid || r.matched_qid,
        source_name: `RFP: ${p.name}`,
        source_ref: `${p.file_name} · row ${r.row_idx + 1}`,
        client: p.name,
        original_question: r.question,
        original_answer: r.answer
      }));
      if (provRows.length) {
        const pr = await state.sb.from("provenance").insert(provRows);
        if (pr.error) toast("Provenance not recorded: " + pr.error.message, "danger");
        else provRows.forEach(r => { state.provCounts[r.question_id] = (state.provCounts[r.question_id] || 0) + 1; });
      }

      // 4) mark finalised
      const { error } = await state.sb.from("rfps").update({
        status: "finalised", finalised_by: state.user.id,
        finalised_at: new Date().toISOString(), finalised_path: finalPath
      }).eq("id", p.id);
      if (error) throw new Error(error.message);

      state.provAll = null;   // history cache now stale
      toast(`Finalised — ${rows.length} answers written, provenance recorded`);
      await openRfp(p.id);
    } catch (e) {
      toast(e.message || String(e), "danger");
    }
    btn.classList.remove("is-loading"); btn.disabled = false;
  }

  async function downloadFinal() {
    const p = state.currentRfp; if (!p || !p.finalised_path) return;
    const dl = await state.sb.storage.from("rfps").download(p.finalised_path);
    if (dl.error) return toast(dl.error.message, "danger");
    const base = p.file_name.replace(/\.(xlsx|xls|xlsm|csv)$/i, "");
    downloadBlob(dl.data, `${base} — Cloudstaff responses.xlsx`);
  }

  /* ========================================================================
     TEAM BOARD — everyone sees every outstanding item, by owner (v0.7.0)
     ======================================================================== */
  function confirmedThisMonthAny(q) {
    const a = state.latestAttestAny[q.id];
    return !!(a && a.outcome === "confirmed" && a.attested_at.slice(0, 7) === new Date().toISOString().slice(0, 7));
  }
  // Board classification mirrors todoFor() but uses *any* DRI's attestation.
  function boardTodoFor(q) {
    if (q.status === "approved-blank" || !q.answer) return "write";
    if (q.needs_rework) return "rework";
    if (!confirmedThisMonthAny(q)) return "confirm";
    return null;
  }
  const BOARD_BADGE = {
    write:   { cls: "badge-warning", label: "Write answer" },
    rework:  { cls: "badge-info",    label: "Rework" },
    confirm: { cls: "badge-neutral", label: "Confirm" }
  };

  async function renderBoard() {
    // Active RFPs with their pending rows (grouped per RFP, per person)
    const [projQ, rowsQ] = await Promise.all([
      state.sb.from("rfps").select("id,name,status,created_by,created_at").eq("status", "in_review"),
      state.sb.from("rfp_rows").select("id,rfp_id,seq,question,band,include,status,assigned_to")
    ]);
    const activeRfps = projQ.data || [];
    const rowsByRfp = {};
    (rowsQ.data || []).forEach(r => { (rowsByRfp[r.rfp_id] = rowsByRfp[r.rfp_id] || []).push(r); });

    const wrap = $("#board-list"); wrap.innerHTML = "";

    // ---- Section 1: one card per active RFP — who is holding it up --------
    if (activeRfps.length) {
      wrap.appendChild(el("h3", null, "Active RFPs"));
      activeRfps
        .slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .forEach(p => {
          const rows = (rowsByRfp[p.id] || []).filter(r => r.include);
          const pend = rows.filter(r => r.status === "pending");
          const done = rows.length - pend.length;
          const byPerson = {};
          pend.forEach(r => { (byPerson[r.assigned_to || "?"] = byPerson[r.assigned_to || "?"] || []).push(r); });
          const det = el("details", "card rfp-board-card" + (pend.length ? "" : " rfp-board-done"));
          if (pend.length) det.open = false;
          det.innerHTML =
            `<summary class="rfp-board-head">
              <span class="cluster cluster-sm"><i class="fa-solid fa-folder-open text-secondary"></i><strong>${esc(p.name)}</strong>
                <span class="text-secondary text-sm">${done} / ${rows.length} approved</span></span>
              <span class="cluster cluster-sm">${
                pend.length
                  ? Object.entries(byPerson).map(([uid, list]) =>
                      `<span class="badge badge-warning badge-sm">${esc(uid === "?" ? "Unassigned" : nameOf(uid))}: ${list.length}</span>`).join(" ")
                  : '<span class="badge badge-success badge-sm">Ready to finalise</span>'
              }<strong class="rfp-board-total">${pend.length}</strong></span>
            </summary>
            <div class="rfp-board-items">${
              pend.length
                ? Object.entries(byPerson).map(([uid, list]) => `
                    <div class="rfp-board-person"><strong class="text-sm">${esc(uid === "?" ? "Unassigned" : nameOf(uid))}</strong> <span class="text-secondary text-xs">is holding ${list.length} answer${list.length === 1 ? "" : "s"}</span></div>` +
                    list.map(r => `
                    <div class="rfp-board-item" data-open-rfp="${esc(p.id)}">
                      <span class="badge ${(IMP_BAND[r.band] || IMP_BAND.gap).cls} badge-sm">${(IMP_BAND[r.band] || IMP_BAND.gap).label}</span>
                      <span class="text-sm rfp-board-q">${esc(r.question.slice(0, 140))}</span>
                    </div>`).join("")).join("")
                : '<p class="text-secondary text-sm" style="margin:0">Everything approved — the owner can finalise.</p>'
            }</div>`;
          $$("[data-open-rfp]", det).forEach(n => n.addEventListener("click", () => openRfp(n.dataset.openRfp)));
          wrap.appendChild(det);
        });
    }

    // ---- Section 2: knowledge-base upkeep, per person ---------------------
    const cards = editorProfiles().map(p => {
      const catIds = new Set(state.drisAll.filter(d => d.user_id === p.user_id).map(d => d.category_id));
      const items = [];
      state.questions.forEach(q => {
        if (!catIds.has(catIdByName(q.category))) return;
        const kind = boardTodoFor(q);
        if (kind) items.push({ kind, ref: q.id, text: q.question, q });
      });
      const counts = { write: 0, rework: 0, confirm: 0 };
      items.forEach(i => counts[i.kind]++);
      return { p, items, counts };
    }).filter(c => c.items.length).sort((a, b) => b.items.length - a.items.length);

    const totalPending = activeRfps.reduce((n, p) => n + ((rowsByRfp[p.id] || []).filter(r => r.include && r.status === "pending").length), 0);
    const totalKb = cards.reduce((n, c) => n + c.items.length, 0);
    $("#board-clear").hidden = !!(activeRfps.length || cards.length);
    $("#board-summary").textContent = (activeRfps.length || cards.length)
      ? `${activeRfps.length} active RFP${activeRfps.length === 1 ? "" : "s"} (${totalPending} answer${totalPending === 1 ? "" : "s"} awaiting approval) · ${totalKb} knowledge-base item${totalKb === 1 ? "" : "s"} outstanding. Visible to everyone signed in.`
      : "Every outstanding item, by owner. Visible to everyone signed in.";

    if (cards.length) {
      wrap.appendChild(el("h3", null, "Knowledge-base upkeep"));
      cards.forEach((c, idx) => {
        const name = c.p.full_name || c.p.email;
        const badges = Object.entries(c.counts).filter(([, n]) => n)
          .map(([k, n]) => `<span class="badge ${BOARD_BADGE[k].cls} badge-sm">${n} ${BOARD_BADGE[k].label}${n === 1 ? "" : "s"}</span>`).join(" ");
        const det = el("details", "card rfp-board-card" + (idx === 0 ? " rfp-board-top" : ""));
        det.innerHTML =
          `<summary class="rfp-board-head">
            <span class="cluster cluster-sm">
              <span class="avatar avatar-sm">${esc(name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase())}</span>
              <strong>${esc(name)}</strong>
              ${c.p.user_id === state.user.id ? '<span class="text-secondary text-sm">(you)</span>' : ""}
            </span>
            <span class="cluster cluster-sm">${badges}<strong class="rfp-board-total">${c.items.length}</strong></span>
          </summary>
          <div class="rfp-board-items">
            ${c.items.map(i => `
              <div class="rfp-board-item" data-open-q="${esc(i.q.id)}">
                <span class="badge ${BOARD_BADGE[i.kind].cls} badge-sm">${BOARD_BADGE[i.kind].label}</span>
                <code class="text-xs">${esc(i.ref)}</code>
                <span class="text-sm rfp-board-q">${esc(i.text.slice(0, 140))}</span>
              </div>`).join("")}
          </div>`;
        $$("[data-open-q]", det).forEach(n => n.addEventListener("click", () => {
          const q = state.questions.find(x => x.id === n.dataset.openQ); if (q) openDrawer(q);
        }));
        wrap.appendChild(det);
      });
    }
  }

  /* ========================================================================
     RFP HISTORY — every RFP with a provenance trail (v0.8.0)
     ======================================================================== */
  // Phase-0 provenance stores per-row source names in several ad-hoc formats.
  // These aliases map each locked historical format to its source RFP; new
  // provenance from Finalise is always "RFP: <name>" and needs no alias.
  const HIST_ALIASES = [
    [/^Vocus RFI/, "Vocus CC & BPO RFI"],
    [/^Sophos/, "Sophos RFP Questionnaire"],
    [/^Pie Insurance/, "Pie Insurance BPO RFP"],
    [/^MNG /, "MNG RFP"],
    [/^Handler /, "Handler RFI + Pricing Schedule"],
    [/^Kensington /, "Kensington Tours pre-qualification"],
    [/^SquareSpace /, "SquareSpace proposal"]
  ];
  function histLabelFor(sourceName, srcList) {
    const alias = HIST_ALIASES.find(([re]) => re.test(sourceName));
    if (alias) return alias[1];
    const src = srcList.find(s => sourceName.startsWith(s.name));
    return src ? src.name : sourceName;
  }

  async function loadAllProvenance() {
    if (state.provAll) return state.provAll;
    let all = [], page = 0;
    for (;;) {
      const { data, error } = await state.sb.from("provenance")
        .select("question_id,source_name,source_ref,original_question,original_answer")
        .order("id").range(page * 1000, page * 1000 + 999);
      if (error) { toast(error.message, "danger"); break; }
      all = all.concat(data || []);
      if (!data || data.length < 1000) break;
      page++;
    }
    state.provAll = all;
    return all;
  }

  async function renderHistory() {
    const [prov, srcs, rfps] = await Promise.all([
      loadAllProvenance(),
      state.sb.from("sources").select("name,kind,tier,source_date"),
      state.sb.from("rfps").select("name,status,finalised_at,created_at")
    ]);
    const srcList = (srcs.data || []).slice().sort((a, b) => b.name.length - a.name.length);
    const groups = {};   // label -> { count, date, kind }
    prov.forEach(r => {
      const label = histLabelFor(r.source_name, srcList);
      const g = groups[label] || (groups[label] = { count: 0 });
      g.count++;
    });
    Object.keys(groups).forEach(label => {
      const src = srcList.find(s => s.name === label);
      const proj = label.startsWith("RFP: ") ? (rfps.data || []).find(p => "RFP: " + p.name === label) : null;
      groups[label].date = proj ? (proj.finalised_at || proj.created_at) : (src && src.source_date) || null;
      groups[label].kind = proj ? "Response project" : (src && src.kind) || "Source";
    });
    const sort = $("#history-sort").value || "az";
    const names = Object.keys(groups).sort((a, b) => sort === "date"
      ? String(groups[b].date || "") .localeCompare(String(groups[a].date || "")) || a.localeCompare(b)
      : a.localeCompare(b));
    const sel = $("#history-select"); sel.innerHTML = "";
    names.forEach(nm => {
      const g = groups[nm];
      const label = `${nm.replace(/^RFP: /, "")} — ${g.count} Q${g.count === 1 ? "" : "s"}${g.date ? ` · ${String(g.date).slice(0, 10)}` : ""}`;
      sel.appendChild(new Option(label, nm));
    });
    if (!names.length) { $("#history-summary").textContent = "No RFPs on record yet."; return; }
    if (!state.currentHistory || !names.includes(state.currentHistory)) state.currentHistory = names[0];
    sel.value = state.currentHistory;
    $("#history-summary").textContent = `${names.length} RFPs on record. Pick one to see every question, the answer given, and the knowledge-base entries used.`;
    await openHistory(state.currentHistory);
  }

    async function openHistory(name) {
    const [prov, srcs] = await Promise.all([loadAllProvenance(), state.sb.from("sources").select("name")]);
    const srcList = (srcs.data || []).slice().sort((a, b) => b.name.length - a.name.length);
    state.currentHistory = name;
    state.currentHistoryRows = prov.filter(r => histLabelFor(r.source_name, srcList) === name);
    renderHistoryDetail();
  }

  function renderHistoryDetail() {
    const name = state.currentHistory, rows = state.currentHistoryRows;
    $("#history-detail-sub").textContent = `${name.replace(/^RFP: /, "")} — ${rows.length} question${rows.length === 1 ? "" : "s"} on record.`;
    const tb = $("#history-detail-rows"); tb.innerHTML = "";
    rows.forEach((r, i) => {
      const tr = el("tr");
      tr.innerHTML =
        `<td class="text-secondary text-sm">${i + 1}</td>` +
        `<td class="rfp-imp-q">${esc((r.original_question || "—").slice(0, 300))}${r.source_ref ? `<small class="text-secondary">${esc(r.source_ref)}</small>` : ""}</td>` +
        `<td class="text-sm">${esc((r.original_answer || "—").slice(0, 400))}</td>` +
        `<td>${r.question_id ? `<a href="#" class="text-sm" data-hview="${esc(r.question_id)}">${esc(r.question_id)}</a>` : "—"}</td>`;
      const a = $("[data-hview]", tr);
      if (a) a.addEventListener("click", e => { e.preventDefault(); const q = state.questions.find(x => x.id === a.dataset.hview); if (q) openDrawer(q); });
      tb.appendChild(tr);
    });
  }

  async function exportHistoryExcel() {
    if (!state.currentHistory || !window.ExcelJS) { if (!window.ExcelJS) toast("Excel engine still loading — try again in a second.", "danger"); return; }
    const name = state.currentHistory.replace(/^RFP: /, "");
    const rows = state.currentHistoryRows;
    const BRAND = "FF007AFF", DARK = "FF14293E", LIGHT = "FFF2F7FF";
    const wb = new ExcelJS.Workbook();
    wb.creator = "Cloudstaff RFP Builder";
    const ws = wb.addWorksheet("RFP Q&A", { views: [{ state: "frozen", ySplit: 4 }] });
    ws.columns = [{ width: 6 }, { width: 60 }, { width: 80 }, { width: 12 }];
    ws.mergeCells("A1:D1"); ws.mergeCells("A2:D2"); ws.mergeCells("A3:D3");
    ws.getCell("A1").value = "CLOUDSTAFF";
    ws.getCell("A1").font = { name: "Calibri", size: 18, bold: true, color: { argb: BRAND } };
    ws.getCell("A2").value = name;
    ws.getCell("A2").font = { name: "Calibri", size: 13, bold: true, color: { argb: DARK } };
    ws.getCell("A3").value = `RFP question & answer record · exported ${new Date().toISOString().slice(0, 10)} · ${rows.length} questions`;
    ws.getCell("A3").font = { name: "Calibri", size: 10, color: { argb: "FF6B7A8C" } };
    const head = ws.getRow(4);
    ["#", "RFP question", "Cloudstaff answer", "KB ref"].forEach((h, i) => {
      const c = head.getCell(i + 1);
      c.value = h;
      c.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
      c.alignment = { vertical: "middle" };
    });
    rows.forEach((r, i) => {
      const row = ws.addRow([i + 1, r.original_question || "", r.original_answer || "", r.question_id || ""]);
      row.alignment = { vertical: "top", wrapText: true };
      if (i % 2 === 1) [1, 2, 3, 4].forEach(ci => { row.getCell(ci).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } }; });
    });
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: "application/octet-stream" }), `${name} — Cloudstaff RFP history.xlsx`);
    toast(`Exported ${rows.length} Q&As`);
  }

  /* ========================================================================
     LIBRARY — supporting videos, docs, certifications, images (v0.8.0)
     ======================================================================== */
  const LIB_SECTIONS = ["General Videos", "Testimonial Videos", "Testimonial Docs", "Brochures", "Certifications", "Support Images", "General Assets", "Legal Assets"];
  const LIB_VIDEO_SECTIONS = ["General Videos", "Testimonial Videos"];
  const LIB_ICON = {
    "General Videos": "fa-circle-play", "Testimonial Videos": "fa-circle-play",
    "Testimonial Docs": "fa-file-lines", "Brochures": "fa-book-open",
    "Certifications": "fa-certificate", "Support Images": "fa-image",
    "General Assets": "fa-box-archive", "Legal Assets": "fa-scale-balanced"
  };

  async function renderLibrary() {
    const { data } = await state.sb.from("resources").select("*").order("id");
    state.resources = data || [];
    const wrap = $("#library-sections"); wrap.innerHTML = "";
    LIB_SECTIONS.forEach(sec => {
      const items = state.resources.filter(r => (r.section || "Certifications") === sec);
      const block = el("div", "stack-sm");
      const head = el("div", "cluster", `<h3>${esc(sec)} <span class="badge badge-neutral badge-sm">${items.length}</span></h3>`);
      head.style.justifyContent = "space-between";
      if (isEditor()) {
        const add = el("button", "button button-secondary button-sm", '<i class="fa-solid fa-plus"></i> Add');
        add.addEventListener("click", () => openResModal(sec));
        head.appendChild(add);
      }
      block.appendChild(head);
      if (!items.length) {
        block.appendChild(el("p", "text-secondary text-sm", "Nothing here yet."));
      } else {
        const grid = el("div", "rfp-lib-grid");
        items.forEach(r => grid.appendChild(libCard(r, sec)));
        block.appendChild(grid);
      }
      wrap.appendChild(block);
    });
  }

  function libCard(r, sec) {
    const card = el("div", "card rfp-lib-card stack-2xs");
    const isImage = sec === "Support Images" && r.file_ref;
    card.innerHTML =
      (isImage ? `<div class="rfp-lib-thumb" data-thumb><span class="spinner spinner--sm"></span></div>`
               : `<div class="rfp-lib-icon"><i class="fa-solid ${LIB_ICON[sec] || "fa-paperclip"}"></i></div>`) +
      `<strong class="text-sm">${esc(r.name)} <code class="text-xs text-secondary">${esc(r.id)}</code></strong>` +
      (r.summary ? `<span class="text-secondary text-xs">${esc(r.summary.slice(0, 100))}</span>` : "") +
      `<span class="text-xs ${r.dri_user_id ? "text-secondary" : "rfp-lib-nodri"}"><i class="fa-solid fa-user-shield"></i> ${r.dri_user_id ? "DRI: " + esc(nameOf(r.dri_user_id)) : "No DRI assigned"}</span>` +
      `<div class="cluster cluster-sm rfp-lib-actions"></div>`;
    const actions = $(".rfp-lib-actions", card);
    if (r.url) {
      const open = el("a", "button button-secondary button-sm", '<i class="fa-solid fa-arrow-up-right-from-square"></i> Open');
      open.href = r.url; open.target = "_blank"; open.rel = "noopener";
      actions.appendChild(open);
    }
    if (r.file_ref) {
      const dl = el("button", "button button-secondary button-sm", '<i class="fa-solid fa-download"></i> Download');
      dl.addEventListener("click", async () => {
        const { data, error } = await state.sb.storage.from("library").createSignedUrl(r.file_ref, 3600);
        if (error) return toast(error.message, "danger");
        const a = el("a"); a.href = data.signedUrl; a.target = "_blank"; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
      });
      actions.appendChild(dl);
    }
    if (isEditor()) {
      const edit = el("button", "button button-tertiary button-sm", '<i class="fa-solid fa-pen"></i>');
      edit.title = "Edit / replace — the asset keeps its ID, bound questions stay linked";
      edit.addEventListener("click", () => openResModal(r.section || sec, r));
      actions.appendChild(edit);
    }
    if (isAdmin()) {
      const del = el("button", "button button-tertiary button-sm", '<i class="fa-solid fa-trash"></i>');
      del.title = "Delete asset (admin only)";
      del.addEventListener("click", () => openResDeleteModal(r));
      actions.appendChild(del);
    }
    if (isImage) {
      state.sb.storage.from("library").createSignedUrl(r.file_ref, 3600).then(({ data }) => {
        const t = $("[data-thumb]", card);
        if (t && data) t.innerHTML = `<img src="${esc(data.signedUrl)}" alt="${esc(r.name)}" loading="lazy">`;
      });
    }
    return card;
  }

    function nextResId() {
    let max = 0;
    state.resources.forEach(r => { const m = /^RES-(\d+)$/.exec(r.id); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    return `RES-${String(max + 1).padStart(2, "0")}`;
  }

  function openResModal(section, resource) {
    if (!isEditor()) return;
    state.resSection = section;
    state.resEditing = resource || null;
    $("#res-modal-title").textContent = resource ? `Edit asset ${resource.id} — bindings keep pointing here` : "Add to the Library";
    $("#res-save").innerHTML = resource ? '<i class="fa-solid fa-floppy-disk"></i> Save changes' : '<i class="fa-solid fa-plus"></i> Add item';
    const sel = $("#res-section"); sel.innerHTML = "";
    LIB_SECTIONS.forEach(s => sel.appendChild(new Option(s, s)));
    sel.value = resource ? (resource.section || section) : section;
    const dri = $("#res-dri"); dri.innerHTML = "";
    editorProfiles().forEach(p => dri.appendChild(new Option(p.full_name || p.email, p.user_id)));
    dri.value = resource && resource.dri_user_id ? resource.dri_user_id : state.user.id;
    if (!dri.value) dri.selectedIndex = 0;
    const syncVideoOnly = () => {
      const videoOnly = LIB_VIDEO_SECTIONS.includes(sel.value);
      $("#res-file-field").hidden = videoOnly;
      if (videoOnly) $("#res-file").value = "";
      $("#res-file-hint").textContent = resource
        ? "Upload only to REPLACE the current file — the asset keeps its ID, so questions bound to it stay linked."
        : "Stored privately; the app serves it with short-lived links. Provide a link OR a file, not both.";
    };
    sel.onchange = syncVideoOnly; syncVideoOnly();
    $("#res-name").value = resource ? resource.name : "";
    $("#res-summary").value = resource ? (resource.summary || "") : "";
    $("#res-url").value = resource ? (resource.url || "") : "";
    $("#res-file").value = "";
    $("#res-error").hidden = true;
    openOverlay("#res-overlay");
  }
  function closeResModal() { $("#res-overlay").hidden = true; document.body.style.overflow = ""; state.resEditing = null; }

  async function saveResource() {
    const err = $("#res-error"); err.hidden = true;
    const editing = state.resEditing;
    const section = $("#res-section").value;
    const name = $("#res-name").value.trim();
    const summary = $("#res-summary").value.trim() || null;
    const url = $("#res-url").value.trim() || null;
    const file = $("#res-file").files[0] || null;
    const driUid = $("#res-dri").value || null;
    if (!name) { err.textContent = "Give it a name."; err.hidden = false; return; }
    if (!driUid) { err.textContent = "Every asset needs a DRI."; err.hidden = false; return; }
    if (LIB_VIDEO_SECTIONS.includes(section)) {
      if (file) { err.textContent = "Videos are link-only — paste a YouTube/Vimeo/public URL instead of uploading."; err.hidden = false; return; }
      if (!url) { err.textContent = "Paste the video URL."; err.hidden = false; return; }
    }
    if (!editing) {
      if (!url && !file) { err.textContent = "Provide a link or upload a file."; err.hidden = false; return; }
      if (url && file) { err.textContent = "Link or file — not both."; err.hidden = false; return; }
    } else if (!url && !file && !editing.file_ref) {
      err.textContent = "The asset needs a link or a file."; err.hidden = false; return;
    }
    const btn = $("#res-save"); btn.classList.add("is-loading"); btn.disabled = true;

    let fileRef = editing ? editing.file_ref : null;
    if (file) {
      const newRef = `${section.toLowerCase().replace(/\s+/g, "-")}/${Date.now()}_${file.name.replace(/[^\w.\- ]+/g, "_")}`;
      const up = await state.sb.storage.from("library").upload(newRef, file, { upsert: true });
      if (up.error) { btn.classList.remove("is-loading"); btn.disabled = false; err.textContent = up.error.message; err.hidden = false; return; }
      fileRef = newRef;
    }
    const patch = { name, type: section, summary, section, url, file_ref: fileRef, dri_user_id: driUid };
    let error;
    if (editing) {
      ({ error } = await state.sb.from("resources").update(patch).eq("id", editing.id));
      if (!error && file && editing.file_ref && editing.file_ref !== fileRef) {
        await state.sb.storage.from("library").remove([editing.file_ref]);   // old copy gone, ID unchanged
      }
    } else {
      ({ error } = await state.sb.from("resources").insert({ id: nextResId(), supports: null, ...patch }));
    }
    btn.classList.remove("is-loading"); btn.disabled = false;
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    closeResModal();
    toast(editing ? `${editing.id} updated — bound questions untouched` : `Added to ${section}`);
    renderLibrary();
  }

  // ---- admin-only delete, with bound-question review + transfer -----------
  async function openResDeleteModal(r) {
    if (!isAdmin()) return;
    state.resDeleting = r;
    $("#resdel-name").textContent = `${r.name} (${r.id}) — ${r.section || "unfiled"}`;
    $("#resdel-error").hidden = true;
    const { data } = await state.sb.from("question_resources").select("question_id").eq("resource_id", r.id);
    state.resDeleteBound = data || [];
    const bound = state.resDeleteBound;
    $("#resdel-bound-wrap").hidden = !bound.length;
    $("#resdel-none").hidden = bound.length > 0;
    if (bound.length) {
      $("#resdel-bound-count").textContent = `${bound.length} question${bound.length === 1 ? " is" : "s are"} bound to this asset.`;
      $("#resdel-bound-list").innerHTML = bound.map(b => {
        const q = state.questions.find(x => x.id === b.question_id);
        return `<div class="rfp-board-item"><code class="text-xs">${esc(b.question_id)}</code><span class="text-sm rfp-board-q">${esc(q ? q.question.slice(0, 120) : "")}</span></div>`;
      }).join("");
      const tsel = $("#resdel-transfer-target"); tsel.innerHTML = "";
      tsel.appendChild(new Option("— Transfer bindings to… —", ""));
      state.resources.filter(x => x.id !== r.id).forEach(x =>
        tsel.appendChild(new Option(`${x.id} · ${x.name} (${x.section || "unfiled"})`, x.id)));
    }
    openOverlay("#resdel-overlay");
  }
  function closeResDeleteModal() { $("#resdel-overlay").hidden = true; document.body.style.overflow = ""; state.resDeleting = null; }

  async function transferAssetBindings() {
    const r = state.resDeleting; if (!r) return;
    const target = $("#resdel-transfer-target").value;
    const err = $("#resdel-error"); err.hidden = true;
    if (!target) { err.textContent = "Pick the asset to transfer the bound Q&A to."; err.hidden = false; return; }
    const rows = state.resDeleteBound.map(b => ({ question_id: b.question_id, resource_id: target }));
    const ins = await state.sb.from("question_resources").upsert(rows, { onConflict: "question_id,resource_id", ignoreDuplicates: true });
    if (ins.error) { err.textContent = ins.error.message; err.hidden = false; return; }
    const del = await state.sb.from("question_resources").delete().eq("resource_id", r.id);
    if (del.error) { err.textContent = del.error.message; err.hidden = false; return; }
    toast(`${rows.length} binding${rows.length === 1 ? "" : "s"} moved to ${target}`);
    openResDeleteModal(r);   // refresh: should now show none bound
  }

  async function confirmAssetDelete() {
    const r = state.resDeleting; if (!r) return;
    const err = $("#resdel-error"); err.hidden = true;
    if (r.file_ref) await state.sb.storage.from("library").remove([r.file_ref]);
    const { error } = await state.sb.from("resources").delete().eq("id", r.id);
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    closeResDeleteModal();
    toast(`${r.id} deleted`);
    renderLibrary();
  }

  /* ========================================================================
     ADMIN — users & DRI mapping (v0.7.0)
     ======================================================================== */
  function renderAdmin() {
    if (!isAdmin()) return;
    const roleOpts = ["viewer", "editor", "admin"];

    const utb = $("#admin-user-rows"); utb.innerHTML = "";
    state.profilesAll.slice().sort((a, b) => (a.full_name || a.email || "").localeCompare(b.full_name || b.email || "")).forEach(p => {
      const ownedCats = state.drisAll.filter(d => d.user_id === p.user_id)
        .map(d => (state.categories.find(c => c.id === d.category_id) || {}).code).filter(Boolean);
      const ownedAssets = state.resources.filter(r => r.dri_user_id === p.user_id).length;
      const self = p.user_id === state.user.id;
      const tr = el("tr");
      tr.innerHTML =
        `<td><strong>${esc(p.full_name || "—")}</strong>${self ? ' <span class="text-secondary text-sm">(you)</span>' : ""}</td>` +
        `<td class="text-sm text-secondary">${esc(p.email || "")}</td>` +
        `<td></td>` +
        `<td class="text-sm">${ownedCats.length ? esc(ownedCats.join(", ")) : ""}${ownedAssets ? `${ownedCats.length ? " · " : ""}${ownedAssets} asset${ownedAssets === 1 ? "" : "s"}` : ""}${!ownedCats.length && !ownedAssets ? '<span class="text-secondary">—</span>' : ""}</td>` +
        `<td class="text-right"></td>`;
      const sel = el("select", "select select-sm");
      roleOpts.forEach(r => sel.appendChild(new Option(r.replace(/^\w/, ch => ch.toUpperCase()), r)));
      sel.value = p.role;
      sel.disabled = self;   // can't demote yourself by accident
      if (self) sel.title = "You can't change your own role.";
      sel.addEventListener("change", async () => {
        if (sel.value === "viewer" && await userOwnsAnything(p.user_id)) {
          sel.value = p.role;
          return toast(`${p.full_name || p.email} still owns categories, assets or RFP answers — transfer them first (use Delete's transfer tool or reassign below).`, "danger");
        }
        const { error } = await state.sb.from("profiles").update({ role: sel.value }).eq("user_id", p.user_id);
        if (error) { sel.value = p.role; return toast(error.message, "danger"); }
        p.role = sel.value;
        toast(`${p.full_name || p.email} is now ${sel.value}`);
        renderAdmin();
      });
      tr.children[2].appendChild(sel);
      const actions = el("div", "cluster cluster-sm"); actions.style.justifyContent = "flex-end";
      const edit = el("button", "button button-tertiary button-sm", '<i class="fa-solid fa-pen"></i>');
      edit.title = "Edit name / role";
      edit.addEventListener("click", () => openUserModal(p));
      actions.appendChild(edit);
      if (!self) {
        const del = el("button", "button button-tertiary button-sm", '<i class="fa-solid fa-user-xmark"></i>');
        del.title = "Delete user";
        del.addEventListener("click", () => openUserDeleteModal(p));
        actions.appendChild(del);
      }
      tr.lastChild.appendChild(actions);
      utb.appendChild(tr);
    });

        const dtb = $("#admin-dri-rows"); dtb.innerHTML = "";
    state.categories.forEach(c => {
      const qCount = state.questions.filter(q => q.category === c.name).length;
      const current = primaryDriForCategoryId(c.id);
      const tr = el("tr");
      tr.innerHTML =
        `<td><strong>${esc(c.name)}</strong> <span class="text-secondary text-sm">${esc(c.code)}</span></td>` +
        `<td class="text-center">${qCount}</td><td></td>`;
      const sel = el("select", "select select-sm");
      sel.appendChild(new Option("— No DRI —", ""));
      editorProfiles().forEach(p => sel.appendChild(new Option(p.full_name || p.email, p.user_id)));
      sel.value = current || "";
      sel.addEventListener("change", async () => {
        const del = await state.sb.from("category_dris").delete().eq("category_id", c.id);
        if (del.error) { sel.value = current || ""; return toast(del.error.message, "danger"); }
        if (sel.value) {
          const ins = await state.sb.from("category_dris").insert({ category_id: c.id, user_id: sel.value, is_primary: true });
          if (ins.error) { sel.value = current || ""; return toast(ins.error.message, "danger"); }
        }
        // refresh local mapping + own todo state
        const { data } = await state.sb.from("category_dris").select("category_id,user_id,is_primary");
        state.drisAll = data || [];
        state.myCategoryIds = new Set(state.drisAll.filter(d => d.user_id === state.user.id).map(d => d.category_id));
        toast(`${c.name} → ${sel.value ? nameOf(sel.value) : "no DRI"}`);
        renderUserBox(); renderAdmin();
      });
      tr.children[2].appendChild(sel);
      dtb.appendChild(tr);
    });
  }

  /* ========================================================================
     ADMIN — user CRUD (v0.11.0; create/delete via SECURITY DEFINER RPCs)
     ======================================================================== */
  async function userOwnsAnything(uid) {
    if (state.drisAll.some(d => d.user_id === uid)) return true;
    if (state.resources.some(r => r.dri_user_id === uid)) return true;
    const { count } = await state.sb.from("rfp_rows").select("id", { count: "exact", head: true })
      .eq("assigned_to", uid).eq("status", "pending");
    return (count || 0) > 0;
  }

  function tempPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let pw = "";
    const rand = new Uint32Array(10); crypto.getRandomValues(rand);
    for (let i = 0; i < 10; i++) pw += chars[rand[i] % chars.length];
    return "Cs!" + pw;
  }

  function openUserModal(profile) {
    if (!isAdmin()) return;
    state.userEditing = profile || null;
    $("#user-modal-title").textContent = profile ? `Edit ${profile.full_name || profile.email}` : "Add user";
    $("#user-save").innerHTML = profile ? '<i class="fa-solid fa-floppy-disk"></i> Save changes' : '<i class="fa-solid fa-user-plus"></i> Create user';
    $("#user-email").value = profile ? (profile.email || "") : "";
    $("#user-email").disabled = !!profile;
    $("#user-name").value = profile ? (profile.full_name || "") : "";
    $("#user-pw-field").hidden = !!profile;
    if (!profile) $("#user-pw").value = tempPassword();
    $("#user-role").value = profile ? profile.role : "viewer";
    $("#user-role").disabled = !!profile && profile.user_id === state.user.id;
    $("#user-error").hidden = true;
    openOverlay("#user-overlay");
  }
  function closeUserModal() { $("#user-overlay").hidden = true; document.body.style.overflow = ""; state.userEditing = null; }

  async function saveUser() {
    const err = $("#user-error"); err.hidden = true;
    const editing = state.userEditing;
    const email = $("#user-email").value.trim().toLowerCase();
    const name = $("#user-name").value.trim();
    const role = $("#user-role").value;
    if (!name) { err.textContent = "Enter the user's full name."; err.hidden = false; return; }
    const btn = $("#user-save"); btn.classList.add("is-loading"); btn.disabled = true;
    try {
      if (editing) {
        if (role === "viewer" && editing.role !== "viewer" && await userOwnsAnything(editing.user_id)) {
          throw new Error("They still own categories, assets or RFP answers — transfer those first.");
        }
        const { error } = await state.sb.from("profiles").update({ full_name: name, role }).eq("user_id", editing.user_id);
        if (error) throw new Error(error.message);
        editing.full_name = name; editing.role = role;
        toast("User updated");
      } else {
        if (!email) throw new Error("Enter an email address.");
        const pw = $("#user-pw").value;
        const { data: uid, error } = await state.sb.rpc("admin_create_user", { p_email: email, p_name: name, p_password: pw });
        if (error) throw new Error(error.message);
        if (role !== "viewer") await state.sb.from("profiles").update({ role }).eq("user_id", uid);
        toast(`${name} created — give them the temporary password`);
      }
      const { data } = await state.sb.from("profiles").select("user_id,email,full_name,role");
      state.profilesAll = data || state.profilesAll;
      closeUserModal();
      renderAdmin();
    } catch (e) {
      err.textContent = e.message || String(e); err.hidden = false;
    }
    btn.classList.remove("is-loading"); btn.disabled = false;
  }

  async function openUserDeleteModal(p) {
    if (!isAdmin() || p.user_id === state.user.id) return;
    state.userDeleting = p;
    $("#userdel-name").textContent = `${p.full_name || p.email} (${p.email}) — ${p.role}`;
    $("#userdel-error").hidden = true;
    const cats = state.drisAll.filter(d => d.user_id === p.user_id)
      .map(d => state.categories.find(c => c.id === d.category_id)).filter(Boolean);
    const assets = state.resources.filter(r => r.dri_user_id === p.user_id);
    const { data: pendRows } = await state.sb.from("rfp_rows")
      .select("id,question,rfps(name,status)").eq("assigned_to", p.user_id).eq("status", "pending");
    const pend = (pendRows || []).filter(r => !r.rfps || r.rfps.status !== "finalised");
    state.userOwned = { cats, assets, pend };
    const total = cats.length + assets.length + pend.length;
    $("#userdel-owned-wrap").hidden = total === 0;
    $("#userdel-none").hidden = total > 0;
    $("#userdel-confirm").disabled = total > 0;
    if (total) {
      $("#userdel-owned-count").textContent =
        `${p.full_name || p.email} owns ${cats.length} categor${cats.length === 1 ? "y" : "ies"}, ${assets.length} asset${assets.length === 1 ? "" : "s"} and ${pend.length} pending RFP answer${pend.length === 1 ? "" : "s"}.`;
      $("#userdel-owned-list").innerHTML =
        cats.map(c => `<div class="rfp-board-item"><span class="badge badge-brand badge-sm">Category</span><span class="text-sm rfp-board-q">${esc(c.name)}</span></div>`).join("") +
        assets.map(r => `<div class="rfp-board-item"><span class="badge badge-neutral badge-sm">Asset</span><code class="text-xs">${esc(r.id)}</code><span class="text-sm rfp-board-q">${esc(r.name)}</span></div>`).join("") +
        pend.map(r => `<div class="rfp-board-item"><span class="badge badge-warning badge-sm">RFP answer</span><span class="text-sm rfp-board-q">${esc((r.rfps ? r.rfps.name + " — " : "") + r.question.slice(0, 100))}</span></div>`).join("");
      const tsel = $("#userdel-transfer-target"); tsel.innerHTML = "";
      tsel.appendChild(new Option("— Transfer everything to… —", ""));
      editorProfiles().filter(x => x.user_id !== p.user_id)
        .forEach(x => tsel.appendChild(new Option(`${x.full_name || x.email} (${x.role})`, x.user_id)));
    }
    openOverlay("#userdel-overlay");
  }
  function closeUserDeleteModal() { $("#userdel-overlay").hidden = true; document.body.style.overflow = ""; state.userDeleting = null; state.userOwned = null; }

  async function transferUserOwnership() {
    const p = state.userDeleting, owned = state.userOwned; if (!p || !owned) return;
    const err = $("#userdel-error"); err.hidden = true;
    const target = $("#userdel-transfer-target").value;
    if (!target) { err.textContent = "Pick the Editor or Admin to transfer everything to."; err.hidden = false; return; }
    try {
      for (const c of owned.cats) {
        let r = await state.sb.from("category_dris").delete().eq("category_id", c.id).eq("user_id", p.user_id);
        if (r.error) throw new Error(r.error.message);
        r = await state.sb.from("category_dris").upsert({ category_id: c.id, user_id: target, is_primary: true }, { onConflict: "category_id,user_id" });
        if (r.error) throw new Error(r.error.message);
      }
      if (owned.assets.length) {
        const r = await state.sb.from("resources").update({ dri_user_id: target }).eq("dri_user_id", p.user_id);
        if (r.error) throw new Error(r.error.message);
      }
      if (owned.pend.length) {
        const r = await state.sb.from("rfp_rows").update({ assigned_to: target }).eq("assigned_to", p.user_id).eq("status", "pending");
        if (r.error) throw new Error(r.error.message);
      }
      // refresh local state
      const [dris, res] = await Promise.all([
        state.sb.from("category_dris").select("category_id,user_id,is_primary"),
        state.sb.from("resources").select("*")
      ]);
      state.drisAll = dris.data || state.drisAll;
      state.resources = res.data || state.resources;
      state.myCategoryIds = new Set(state.drisAll.filter(d => d.user_id === state.user.id).map(d => d.category_id));
      toast(`Everything transferred to ${nameOf(target)}`);
      openUserDeleteModal(p);   // refresh: should now show "owns nothing"
    } catch (e) {
      err.textContent = e.message || String(e); err.hidden = false;
    }
  }

  async function confirmUserDelete() {
    const p = state.userDeleting; if (!p) return;
    const err = $("#userdel-error"); err.hidden = true;
    const btn = $("#userdel-confirm"); btn.classList.add("is-loading"); btn.disabled = true;
    const { error } = await state.sb.rpc("admin_delete_user", { p_uid: p.user_id });
    btn.classList.remove("is-loading");
    if (error) { btn.disabled = false; err.textContent = error.message; err.hidden = false; return; }
    const { data } = await state.sb.from("profiles").select("user_id,email,full_name,role");
    state.profilesAll = data || state.profilesAll.filter(x => x.user_id !== p.user_id);
    closeUserDeleteModal();
    toast(`${p.full_name || p.email} deleted`);
    renderAdmin();
  }
})();