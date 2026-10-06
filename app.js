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

const state = { prospects: [], filter: null };
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
  const prospects = await db.from("prospects_cartes").select("*");
  if (prospects.error) return showError(prospects.error);
  state.prospects = prospects.data;
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
      class: `chip ${value ? STATUT_CLASS[value] : ""} ${state.filter === value ? "active" : ""} ${n === 0 ? "empty-status" : ""}`,
      "aria-pressed": String(state.filter === value),
      onclick: () => { state.filter = value; renderFilters(); renderCards(); },
    }, value && h("span", { class: "dot" }), label, h("span", { class: "count" }, n));
  nav.append(chip("Tous", null, state.prospects.length), ...STATUTS.map((s) => chip(s, s, counts[s])));

  // Barre de proportions : un segment par statut, largeur = nombre de prospects
  $("pipeline").replaceChildren(...STATUTS.filter((s) => counts[s]).map((s) =>
    h("span", { class: STATUT_CLASS[s], style: `flex: ${counts[s]}`, title: `${s} : ${counts[s]}` })));

  // Résumé : ce qui demande une action aujourd'hui ou est en retard
  const open = state.prospects.filter((p) => p.statut !== "Terminé");
  const t = today();
  const dueToday = open.filter((p) => p.date_prochaine_action === t).length;
  const late = open.filter((p) => p.date_prochaine_action && p.date_prochaine_action < t).length;
  const parts = [h("strong", {}, `${open.length} processus en cours`)];
  if (dueToday) parts.push(`, ${dueToday} échéance${dueToday > 1 ? "s" : ""} aujourd'hui`);
  if (late) parts.push(`, ${late} en retard`);
  if (!dueToday && !late) parts.push(", rien d'urgent aujourd'hui");
  $("summary").replaceChildren(...parts);
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

/** Tampon de date de la prochaine action : jour de la semaine, jour, mois ; aujourd'hui / en retard mis en évidence. */
function stamp(p) {
  const due = p.date_prochaine_action;
  if (!due) return h("div", { class: "stamp none", title: "Pas d'échéance" }, h("span", { class: "d" }, "—"));
  const [y, m, d] = due.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const part = (opts) => date.toLocaleDateString("fr-FR", { timeZone: "UTC", ...opts });
  const isToday = due === today();
  const late = due < today() && p.statut !== "Terminé";
  return h("div", { class: `stamp ${isToday ? "today" : ""} ${late ? "late" : ""}`,
    title: isToday ? "Aujourd'hui" : late ? "En retard" : fmtDateOnly(due) },
    h("span", { class: "wd" }, isToday ? "auj." : late ? "retard" : part({ weekday: "short" })),
    h("span", { class: "d" }, d),
    h("span", { class: "mo" }, part({ month: "short" })),
  );
}

function statusLabel(p) {
  return h("span", { class: `status ${STATUT_CLASS[p.statut] || ""}` }, h("span", { class: "dot" }), p.statut || "Sans statut");
}

/** « Poste, via intermédiaire » (l'intermédiaire seulement si l'entreprise est connue : sinon il sert de titre). */
function subtitle(p) {
  const via = p.entreprise && p.intermediaire && `via ${p.intermediaire}`;
  if (!p.poste && !via) return null;
  return h("p", { class: "row-sub" }, p.poste && h("span", { class: "poste" }, p.poste), p.poste && via && ", ", via);
}

function card(p) {
  const n = p.nb_echanges || 0;
  const canal = p.dernier_canal && h("span", { class: `canal canal-${p.dernier_canal}` }, p.dernier_canal === "gmail" ? "Gmail" : "WhatsApp");
  return h("article", { class: `row ${STATUT_CLASS[p.statut] || ""}`, tabindex: "0", role: "button", "data-id": p.id,
    "aria-label": `${title(p)}, ${p.poste || ""}, ${p.statut || "sans statut"}`,
    onclick: () => { if (Date.now() - lastDragEnd > 400) openDetail(p.id); },
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(p.id); } },
  },
    h("span", { class: "handle", title: "Glisser pour déplacer", "aria-hidden": "true",
      onclick: (e) => e.stopPropagation() }, "⠿"),
    stamp(p),
    h("div", { class: "row-main" },
      h("div", { class: "row-title" }, h("h2", {}, title(p)), statusLabel(p)),
      subtitle(p),
      p.prochaine_action && h("p", { class: "next" }, p.prochaine_action),
      h("p", { class: "row-meta" },
        `${n} échange${n > 1 ? "s" : ""}`,
        p.dernier_echange && `, le dernier ${relative(p.dernier_echange)}`,
        canal && " sur ", canal),
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

  // Grand écran : contacts et notes ouverts dans la colonne latérale ; téléphone : repliés sous la prochaine action.
  const wide = matchMedia("(min-width: 900px)").matches;
  const panel = (label, count, content) =>
    h("details", { class: "panel", open: wide || null },
      h("summary", {}, label, count != null && h("span", { class: "count" }, count)),
      h("div", { class: "panel-body" }, content));

  body.replaceChildren(h("article", { class: "fiche" },
    h("header", { class: "fiche-head" },
      statusLabel(p),
      h("h2", { id: "detail-title" }, title(p)),
      subtitle(p),
    ),
    h("section", { class: "next-panel" },
      stamp(p),
      h("div", {},
        h("h3", {}, p.date_prochaine_action ? `Prochaine action, ${fmtDateOnly(p.date_prochaine_action)}` : "Prochaine action"),
        h("p", {}, p.prochaine_action || "Aucune action prévue."),
      ),
    ),
    (contacts.data.length > 0 || p.notes) && h("aside", { class: "fiche-aside" },
      p.notes && panel("Notes", null, notesList(p.notes)),
      contacts.data.length > 0 && panel("Contacts", contacts.data.length, h("ul", { class: "contacts" }, contacts.data.map(contactItem))),
    ),
    h("section", { class: "feed" },
      h("h3", {}, "Échanges ", h("span", { class: "count" }, echanges.data.length)),
      timeline(echanges.data, byContact, urls),
      h("p", { class: "meta" }, `Fiche n° ${p.id}, créée ${relative(p.created_at)}, mise à jour ${relative(p.updated_at)}`),
    ),
  ));
}

/**
 * Notes : un fait par ligne ; « [AAAA-MM-JJ] » en tête de ligne ouvre une nouvelle analyse.
 * Rendu : faits en liste, groupés par analyse, date affichée une fois par jour.
 */
function notesList(notes) {
  const groups = [];
  for (const line of notes.split("\n")) {
    const m = line.match(/^\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
    if (m || !groups.length) groups.push({ date: m?.[1] ?? null, items: [] });
    const text = (m ? m[2] : line).replace(/^\s*[-•*]\s*/, "").trim();
    if (text) groups.at(-1).items.push(text.replace(/\b\d{4}-(\d{2})-(\d{2})\b/g, "$2/$1"));
  }
  return h("div", { class: "notes" }, groups.filter((g) => g.items.length).map((g, i, all) =>
    h("div", { class: "note-group" },
      g.date && g.date !== all[i - 1]?.date && h("p", { class: "note-date" }, fmtDateOnly(g.date)),
      h("ul", {}, g.items.map((x) => h("li", {}, x))),
    )));
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
        author && h("span", { class: "author" }, author),
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
