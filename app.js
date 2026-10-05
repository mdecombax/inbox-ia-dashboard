// Inbox-ia : dashboard en lecture seule, sans connexion (lecture publique, aucune écriture possible).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import Sortable from "https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/+esm";

// Clé publique : lecture seule (RLS), les écritures exigent la clé secrète du démon.
const SUPABASE_URL = "https://qhyndxktnllkuabomsoa.supabase.co";
const SUPABASE_KEY = "sb_publishable_Uy5OTL4ade2bb3BhrfUStA_Vef6ugDM";
const BUCKET = "pieces-jointes";
const TZ = "America/Mexico_City";

const STATUTS = ["Action requise", "Programmé", "En attente", "Terminé"];
const STATUT_CLASS = {
  "Action requise": "s-action",
  "Programmé": "s-programme",
  "En attente": "s-attente",
  "Terminé": "s-termine",
};

const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const $ = (id) => document.getElementById(id);

const state = { prospects: [], contacts: [], filter: null };
window.debug = { state, db }; // inspection depuis la console

// ---------------------------------------------------------------- utilitaires

/** Crée un élément ; le texte passe par textContent (jamais d'HTML injecté). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtDay = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtTime = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }); // AAAA-MM-JJ

const today = () => dayKey.format(new Date());

/** « AAAA-MM-JJ » (date sans heure, ex. date_prochaine_action) → libellé court. */
function fmtDateOnly(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("fr-FR", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}

function relative(ts) {
  if (!ts) return "";
  const days = Math.round((new Date(today()) - new Date(dayKey.format(new Date(ts)))) / 86400000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days < 30) return `il y a ${days} j`;
  return fmtDay.format(new Date(ts));
}

function title(p) {
  return p.entreprise || p.intermediaire || "Entreprise inconnue";
}

function showError(err) {
  console.error(err);
  const el = $("error");
  el.textContent = `Erreur : ${err?.message || err}`;
  el.hidden = false;
}

// ---------------------------------------------------------------- liste

async function load() {
  $("app").hidden = true;
  const [prospects, contacts] = await Promise.all([
    db.from("prospects_cartes").select("*"),
    db.from("contacts").select("prospect_id, nom, email, telephone"),
  ]);
  if (prospects.error) return showError(prospects.error);
  if (contacts.error) return showError(contacts.error);
  state.prospects = prospects.data;
  state.contacts = contacts.data;
  $("boot").hidden = true;
  $("app").hidden = false;
  renderFilters();
  renderCards();
  route();
}

// Ordre manuel (glisser-déposer) ; les nouveaux prospects (ordre null) passent en tête, par urgence.
function sortKey(p) {
  const rank = STATUTS.indexOf(p.statut);
  return [
    p.ordre == null ? -1 : p.ordre,
    rank < 0 ? STATUTS.length : rank,
    p.date_prochaine_action || "9999-12-31",
    -(p.dernier_echange ? Date.parse(p.dernier_echange) : 0),
  ];
}

function compare(a, b) {
  const ka = sortKey(a), kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}

function matches(p) {
  return !state.filter || p.statut === state.filter;
}

function renderFilters() {
  const nav = $("filters");
  nav.replaceChildren();
  const counts = Object.fromEntries(STATUTS.map((s) => [s, state.prospects.filter((p) => p.statut === s).length]));
  const chip = (label, value, n) =>
    h("button", {
      type: "button",
      class: `chip ${value ? STATUT_CLASS[value] : ""} ${state.filter === value ? "active" : ""}`,
      "aria-pressed": String(state.filter === value),
      onclick: () => { state.filter = value; renderFilters(); renderCards(); },
    }, label, h("span", { class: "count" }, n));
  nav.append(chip("Tous", null, state.prospects.length), ...STATUTS.map((s) => chip(s, s, counts[s])));
}

let sortable = null;
let lastDragEnd = 0; // le lâcher d'une carte déclenche un clic : ne pas ouvrir la fiche à ce moment-là

function renderCards() {
  const list = state.prospects.filter(matches).sort(compare);
  const main = $("cards");
  main.replaceChildren(...list.map(card));
  $("empty").hidden = list.length > 0;
  // Réordonner n'a de sens que sur la liste complète : désactivé pendant un filtre.
  const canSort = !state.filter;
  main.classList.toggle("sortable-off", !canSort);
  $("sort-hint").hidden = canSort;
  // forceFallback : même rendu à la souris et au doigt (la carte déplacée est un clone stylé .drag-card).
  sortable ??= Sortable.create(main, {
    handle: ".handle",
    animation: 180,
    easing: "cubic-bezier(.2, 0, 0, 1)",
    forceFallback: true,
    fallbackClass: "drag-card",
    fallbackTolerance: 3,
    ghostClass: "ghost-card",
    scroll: true,
    bubbleScroll: true,
    onStart: () => main.classList.add("dragging"),
    onEnd: (e) => { main.classList.remove("dragging"); lastDragEnd = Date.now(); saveOrder(e); },
  });
  sortable.option("disabled", !canSort);
}

async function saveOrder() {
  const ids = [...$("cards").children].map((el) => Number(el.dataset.id));
  ids.forEach((id, i) => { const p = state.prospects.find((x) => x.id === id); if (p) p.ordre = i + 1; });
  const { error } = await db.rpc("ordonner_prospects", { ids });
  if (error) { showError(error); await load(); }
}

function card(p) {
  const due = p.date_prochaine_action;
  const late = due && due < today() && p.statut !== "Terminé";
  const isToday = due && due === today();
  const contacts = state.contacts.filter((c) => c.prospect_id === p.id);
  return h("article", { class: `card ${STATUT_CLASS[p.statut] || ""}`, tabindex: "0", role: "button", "data-id": p.id,
    "aria-label": `${title(p)}, ${p.poste || ""}, ${p.statut || "sans statut"}`,
    onclick: () => { if (Date.now() - lastDragEnd > 400) openDetail(p.id); },
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(p.id); } },
  },
    h("div", { class: "card-head" },
      h("span", { class: "handle", title: "Glisser pour déplacer", "aria-hidden": "true",
        onclick: (e) => e.stopPropagation() }, "⠿"),
      h("span", { class: `badge ${STATUT_CLASS[p.statut] || ""}` }, p.statut || "Sans statut"),
      p.dernier_canal && h("span", { class: `canal canal-${p.dernier_canal}` }, p.dernier_canal === "gmail" ? "Gmail" : "WhatsApp"),
    ),
    h("h2", {}, title(p)),
    p.poste && h("p", { class: "poste" }, p.poste),
    p.entreprise && p.intermediaire && h("p", { class: "via" }, `via ${p.intermediaire}`),
    p.prochaine_action && h("p", { class: "next" },
      due && h("span", { class: `due ${late ? "late" : ""} ${isToday ? "today" : ""}` }, isToday ? "Aujourd'hui" : fmtDateOnly(due)),
      p.prochaine_action),
    h("footer", { class: "card-foot" },
      h("span", {}, `${p.nb_echanges} échange${p.nb_echanges > 1 ? "s" : ""}`),
      p.dernier_echange && h("span", {}, `dernier ${relative(p.dernier_echange)}`),
      contacts.length > 0 && h("span", {}, contacts.map((c) => c.nom).join(", ")),
    ),
  );
}

// ---------------------------------------------------------------- fiche

function openDetail(id) {
  location.hash = `#/p/${id}`;
}

function route() {
  const m = location.hash.match(/^#\/p\/(\d+)$/);
  if (m && !$("app").hidden) showDetail(Number(m[1]));
  else closeDetail();
}

function closeDetail() {
  $("detail").hidden = true;
  document.body.classList.remove("no-scroll");
}

async function showDetail(id) {
  const p = state.prospects.find((x) => x.id === id);
  if (!p) return closeDetail();
  const body = $("detail-body");
  body.replaceChildren(h("p", { class: "loading" }, "Chargement…"));
  $("detail").hidden = false;
  document.body.classList.add("no-scroll");
  $("back").focus();

  const [contacts, echanges] = await Promise.all([
    db.from("contacts").select("*").eq("prospect_id", id).order("id"),
    db.from("echanges").select("*, pieces_jointes(*)").eq("prospect_id", id).order("date", { ascending: true, nullsFirst: true }).order("id"),
  ]);
  if (contacts.error) return showError(contacts.error);
  if (echanges.error) return showError(echanges.error);

  const files = echanges.data.flatMap((e) => e.pieces_jointes || []);
  const urls = await signedUrls(files.map((f) => f.chemin));
  const byContact = Object.fromEntries(contacts.data.map((c) => [c.id, c]));

  body.replaceChildren(
    h("div", { class: "detail-head" },
      h("span", { class: `badge ${STATUT_CLASS[p.statut] || ""}` }, p.statut || "Sans statut"),
      h("h2", { id: "detail-title" }, title(p)),
      p.poste && h("p", { class: "poste" }, p.poste),
      p.entreprise && p.intermediaire && h("p", { class: "via" }, `via ${p.intermediaire}`),
    ),
    p.prochaine_action && h("section", { class: "block next-block" },
      h("h3", {}, "Prochaine action"),
      h("p", {}, p.date_prochaine_action && h("strong", {}, `${fmtDateOnly(p.date_prochaine_action)} · `), p.prochaine_action),
    ),
    contacts.data.length > 0 && h("section", { class: "block" },
      h("h3", {}, "Contacts"),
      h("ul", { class: "contacts" }, contacts.data.map(contactItem)),
    ),
    p.notes && h("section", { class: "block" },
      h("h3", {}, "Notes"),
      h("p", { class: "notes" }, p.notes),
    ),
    h("section", { class: "block" },
      h("h3", {}, `Échanges (${echanges.data.length})`),
      timeline(echanges.data, byContact, urls),
    ),
    h("p", { class: "meta" }, `Fiche #${p.id} · créée ${relative(p.created_at)} · mise à jour ${relative(p.updated_at)}`),
  );
}

function contactItem(c) {
  const digits = (c.telephone || "").replace(/\D/g, "");
  return h("li", {},
    h("strong", {}, c.nom),
    c.role && h("span", { class: "role" }, c.role),
    h("span", { class: "links" },
      c.telephone && h("a", { href: `tel:${c.telephone}` }, c.telephone),
      digits && h("a", { href: `https://wa.me/${digits}`, target: "_blank", rel: "noopener" }, "WhatsApp"),
      c.email && h("a", { href: `mailto:${c.email}` }, c.email),
    ),
  );
}

async function signedUrls(paths) {
  if (!paths.length) return {};
  const { data, error } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) { showError(error); return {}; }
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

function timeline(echanges, byContact, urls) {
  if (!echanges.length) return h("p", { class: "empty" }, "Aucun échange.");
  const out = h("ol", { class: "timeline" });
  let lastDay = null;
  for (const e of echanges) {
    const day = e.date ? dayKey.format(new Date(e.date)) : "sans date";
    if (day !== lastDay) {
      out.append(h("li", { class: "day" }, e.date ? fmtDay.format(new Date(e.date)) : "Date inconnue"));
      lastDay = day;
    }
    const author = e.auteur || byContact[e.contact_id]?.nom || (e.direction === "envoyé" ? "Moi" : "");
    out.append(h("li", { class: `msg ${e.direction === "envoyé" ? "out" : "in"}` },
      h("div", { class: "msg-meta" },
        h("span", { class: `canal canal-${e.canal}` }, e.canal === "gmail" ? "Gmail" : "WhatsApp"),
        author && h("span", {}, author),
        e.date && e.date_precision === "heure" && h("time", { datetime: e.date }, fmtTime.format(new Date(e.date))),
      ),
      h("p", { class: "msg-text" }, e.contenu),
      e.resume && h("p", { class: "msg-resume" }, e.resume),
      (e.pieces_jointes || []).length > 0 && h("div", { class: "files" },
        e.pieces_jointes.map((f) => fileLink(f, urls[f.chemin]))),
    ));
  }
  return out;
}

function fileLink(f, url) {
  const name = f.chemin.split("/").pop();
  if (!url) return h("span", { class: "file" }, name);
  if ((f.type || "").startsWith("image/")) {
    return h("a", { class: "thumb", href: url, target: "_blank", rel: "noopener" },
      h("img", { src: url, alt: name, loading: "lazy" }));
  }
  return h("a", { class: "file", href: url, target: "_blank", rel: "noopener" }, `📎 ${name}`);
}

// ---------------------------------------------------------------- démarrage

$("back").addEventListener("click", () => {
  if (history.length > 1 && location.hash) history.back();
  else location.hash = "";
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("detail").hidden) $("back").click(); });
window.addEventListener("hashchange", route);

load().catch(showError);
