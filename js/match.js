/* ==========================================================================
   Cloudstaff RFP Builder — client-side question matcher
   Pure, dependency-free TF-IDF + cosine similarity over the canonical
   question corpus. Runs in the browser (window.RFPMatch) and in Node
   (module.exports) so the algorithm can be unit-tested off-page.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RFPMatch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Common English + RFP boilerplate stopwords. Kept deliberately broad so
  // that "please confirm you agree that..." noise doesn't drive matches.
  const STOP = new Set((
    "a an and are as at be but by for if in into is it no not of on or such " +
    "that the their then there these they this to was will with you your yours " +
    "we our us they them he she his her its i me my " +
    "please provide describe detail details explain confirm indicate list state " +
    "agree agrees agreed agreement following below above any all each which what " +
    "how when where who whom why does do did done can could would should may might " +
    "must shall have has had been being about also this these those other others " +
    "question questions answer answers response responses supplier client customer " +
    "company companies service services offer offering bid bids event online yes no " +
    "na section per within during throughout ensure include includes including " +
    "requirement requirements required require requires able ability provide " +
    "comment comments attach attachment attached mark check choose option options " +
    "term terms number amount level levels type types item items point points"
  ).split(/\s+/));

  // Very light suffix stemmer — folds obvious morphological variants together
  // (locations→location, reporting→report, encrypted→encrypt) without a full
  // stemming library.
  function stem(w) {
    if (w.length <= 4) return w;
    if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
    if (w.endsWith("ies") && w.length > 5) return w.slice(0, -3) + "y";
    if (w.endsWith("ers") && w.length > 5) return w.slice(0, -1);
    if (w.endsWith("es")  && w.length > 5) return w.slice(0, -2);
    if (w.endsWith("ed")  && w.length > 5) return w.slice(0, -2);
    if (w.endsWith("s")   && !w.endsWith("ss") && w.length > 4) return w.slice(0, -1);
    return w;
  }

  function tokenize(text) {
    if (!text) return [];
    const out = [];
    const raw = String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/);
    for (const t of raw) {
      if (!t || t.length < 3) continue;
      if (STOP.has(t)) continue;
      if (/^\d+$/.test(t) && t.length < 4) continue; // drop stray small numbers
      out.push(stem(t));
    }
    return out;
  }

  function termFreq(tokens) {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
  }

  // Build an index over the canonical questions.
  // `questions` = array of objects; textOf(q) returns the string to index.
  function buildIndex(questions, textOf) {
    textOf = textOf || ((q) => (q.question || q.q || ""));
    const N = questions.length || 1;
    const df = new Map();
    const docs = questions.map((q) => {
      const toks = tokenize(textOf(q));
      const tf = termFreq(toks);
      for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
      return { q, tf };
    });
    const idf = new Map();
    for (const [term, d] of df) idf.set(term, Math.log((N + 1) / (d + 1)) + 1);

    // Pre-compute unit-normalised weighted vectors for each doc.
    const vectors = docs.map((d) => weightedVector(d.tf, idf));
    return { docs, idf, vectors, N };
  }

  function weightedVector(tf, idf) {
    const vec = new Map();
    let norm = 0;
    for (const [term, count] of tf) {
      const w = (1 + Math.log(count)) * (idf.get(term) || Math.log(2) + 1);
      vec.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const term of vec.keys()) vec.set(term, vec.get(term) / norm);
    return vec;
  }

  function cosine(a, b) {
    // iterate the smaller map
    let small = a, big = b;
    if (a.size > b.size) { small = b; big = a; }
    let dot = 0;
    for (const [term, w] of small) { const w2 = big.get(term); if (w2) dot += w * w2; }
    return dot;
  }

  // Jaccard over token sets — a cheap complement that rewards raw overlap and
  // stabilises very short questions where TF-IDF is noisy.
  function jaccard(qTokensSet, docTf) {
    if (!qTokensSet.size || !docTf.size) return 0;
    let inter = 0;
    for (const t of qTokensSet) if (docTf.has(t)) inter++;
    const union = qTokensSet.size + docTf.size - inter;
    return union ? inter / union : 0;
  }

  // Match a single query string against the index; returns ranked candidates.
  function match(queryText, index, topN) {
    topN = topN || 3;
    const qTokens = tokenize(queryText);
    if (!qTokens.length) return [];
    const qtf = termFreq(qTokens);
    const qvec = weightedVector(qtf, index.idf);
    const qset = new Set(qTokens);

    const scored = index.docs.map((d, i) => {
      const cos = cosine(qvec, index.vectors[i]);
      const jac = jaccard(qset, d.tf);
      // Blend: cosine carries the weight, Jaccard nudges. Both in 0..1.
      const score = 0.8 * cos + 0.2 * jac;
      return { q: d.q, score, cos, jac };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }

  // Confidence banding from a blended score.
  function band(score) {
    if (score >= 0.42) return "strong";
    if (score >= 0.18) return "partial";
    return "gap";
  }

  return { tokenize, buildIndex, match, band, stem };
});
