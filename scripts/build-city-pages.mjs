#!/usr/bin/env node
/**
 * Genereerib linnalehed (SEO) — /tartu, /tallinn, ... — koos sitemap.xml ja robots.txt'iga.
 *
 * Miks: avaleht on ühe lehe rakendus, mille asukohad joonistab brauser JS-iga,
 * seega otsingumootor näeb sealt vaid sissejuhatust. Siin tekitame iga
 * suurema linna kohta päris HTML-lehe, kus asukohtade nimekiri on juba
 * valmis kujul.
 *
 * Käivitus (Cloudflare Pages build command):  node scripts/build-city-pages.mjs
 * Andmed tuleb meie enda worker'ilt (/lockers), mitte otse vedajatelt.
 * Kohalik test failiga:  node scripts/build-city-pages.mjs --input lockers.json
 *
 * Seadistus keskkonnamuutujatega (kõigil on vaikeväärtus):
 *   LOCKERS_URL         worker'i /lockers aadress
 *   SITE_URL            lehe avalik aadress (canonical + sitemap), ilma lõpu-/-ta
 *   MIN_LOCKERS         vähim asukohtade arv, et linn saaks oma lehe (vaikimisi 5)
 *   MIN_TOTAL_LOCKERS   kaitse: kui andmeid on vähem, katkestame ehituse (vaikimisi 500),
 *                       et tühja/katkise vastusega ei avaldataks tühje lehti
 *
 * Unisend on kaasatud (Unisend kinnitas kirjalikult, et API/CSV kasutamine on lubatud).
 *
 * Genereeritud failid (<linn>.html, sitemap.xml, robots.txt) on .gitignore'is —
 * need tekivad deploy'l, mitte ei kuulu repo'sse.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_URL = process.env.LOCKERS_URL || "https://epakiautomaadid.roolikatted.workers.dev/lockers";
const SITE_URL = (process.env.SITE_URL || "https://www.pakiautomaat24.eu").replace(/\/+$/, "");
const MIN_LOCKERS = Number(process.env.MIN_LOCKERS || 5);
const MIN_TOTAL_LOCKERS = Number(process.env.MIN_TOTAL_LOCKERS || 500);
const RELATED_COUNT = 8;
const HOME_LINKS_COUNT = 40;

const SOURCE_LABELS = { omniva: "Omniva", dpd: "DPD", smartpost: "Smartpost", venipak: "Venipak", unisend: "Unisend" };
const SOURCE_ORDER = ["omniva", "dpd", "smartpost", "venipak", "unisend"];
const RESERVED_SLUGS = new Set(["index", "app", "worker", "theme-init", "city-map", "sitemap", "robots", "readme", "404", "privaatsus", "tingimused", "kontakt", "fonts", "vendor"]);

const args = process.argv.slice(2);
const inputIdx = args.indexOf("--input");
const inputFile = inputIdx >= 0 ? args[inputIdx + 1] : null;
const today = new Date().toISOString().slice(0, 10);

// ---------- väikesed abifunktsioonid ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// JSON <script type="application/json"> sisse: "<" välja, et "</script>" ei saaks tekstist plokki sulgeda.
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[äàáâ]/g, "a")
    .replace(/[õöòóô]/g, "o")
    .replace(/[üùúû]/g, "u")
    .replace(/š/g, "s")
    .replace(/ž/g, "z")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanCity(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim().replace(/\s+linn$/i, "");
}

function placesWord(n) {
  return n === 1 ? "asukoht" : "asukohta";
}

function distKm(a, b) {
  const dLat = (a.lat - b.lat) * 111.2;
  const dLon = (a.lon - b.lon) * 111.2 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

async function loadData() {
  if (inputFile) return JSON.parse(fs.readFileSync(path.resolve(inputFile), "utf8"));
  const res = await fetch(WORKER_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Worker vastas HTTP ${res.status}`);
  return res.json();
}

// ---------- andmete grupeerimine ----------
function groupByCity(rawLockers) {
  const usable = rawLockers
    .filter((r) => r && SOURCE_LABELS[r.source]) // tundmatud allikad välja
    .filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)))
    .map((r) => ({
      source: r.source,
      name: String(r.name || "").trim() || SOURCE_LABELS[r.source] + " asukoht",
      address: [r.street, r.zip].filter(Boolean).join(", "),
      hours: String(r.hours || "").trim(),
      info: String(r.locationInfo || "").trim(),
      lat: Number(r.lat),
      lon: Number(r.lon),
      city: cleanCity(r.city),
    }))
    .filter((r) => r.city);

  const groups = new Map(); // slug -> {slug, variants:Map, items:[]}
  for (const it of usable) {
    const slug = slugify(it.city);
    if (!slug) continue;
    if (!groups.has(slug)) groups.set(slug, { slug, variants: new Map(), items: [] });
    const g = groups.get(slug);
    g.variants.set(it.city, (g.variants.get(it.city) || 0) + 1);
    g.items.push(it);
  }

  const cities = [];
  for (const g of groups.values()) {
    const name = [...g.variants.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const counts = {};
    for (const it of g.items) counts[it.source] = (counts[it.source] || 0) + 1;
    const lat = g.items.reduce((s, i) => s + i.lat, 0) / g.items.length;
    const lon = g.items.reduce((s, i) => s + i.lon, 0) / g.items.length;
    g.items.sort((a, b) => a.name.localeCompare(b.name, "et"));
    cities.push({ slug: g.slug, name, items: g.items, counts, lat, lon, variants: g.variants });
  }
  return { usableCount: usable.length, cities };
}

// ---------- HTML ----------
function carrierSummary(c) {
  return SOURCE_ORDER.filter((s) => c.counts[s]).map((s) => `${SOURCE_LABELS[s]} ${c.counts[s]}`).join(", ");
}

// Sisseütlev kääne ("Tartus"). Teadlikult käsitsi: automaatne tuletamine annaks vigu.
// Tundmatu linna puhul jäetakse kääne ära ja kasutatakse neutraalset sõnastust.
const LOCATIVE = {
  tallinn: "Tallinnas", tartu: "Tartus", parnu: "Pärnus", narva: "Narvas",
  "kohtla-jarve": "Kohtla-Järvel", viljandi: "Viljandis", keila: "Keilas",
  maardu: "Maardus", rakvere: "Rakveres", haapsalu: "Haapsalus", voru: "Võrus",
  paide: "Paides", sillamae: "Sillamäel", loksa: "Loksal",
  "narva-joesuu": "Narva-Jõesuus", kuressaare: "Kuressaares", johvi: "Jõhvis",
  valga: "Valgas", jogeva: "Jõgeval", rapla: "Raplas", tapa: "Tapal",
  kunda: "Kundas", elva: "Elvas", polva: "Põlvas", turi: "Türil", sindi: "Sindis",
  saue: "Sauel", kehra: "Kehras", kardla: "Kärdlas", tamsalu: "Tamsalus",
  otepaa: "Otepääl", kivioli: "Kiviõlis", kohila: "Kohilas", paldiski: "Paldiskis",
  rapina: "Räpinas", antsla: "Antslas", mustvee: "Mustvees", vohma: "Võhmas",
  "abja-paluoja": "Abja-Paluojal", "kilingi-nomme": "Kilingi-Nõmmes",
};

const EXTRA_CSS = `
.crumbs{font-size:.78rem;color:var(--muted)}
.crumbs a{color:inherit}
.carrier-split{list-style:none;padding:0;margin:6px 0 0;display:flex;flex-wrap:wrap;gap:8px 18px}
.carrier-split li{display:flex;align-items:center;gap:6px;color:var(--ink)}
.locker-list{list-style:none;margin:6px 0 0;padding:0;columns:2 320px;column-gap:28px}
.locker-list li{break-inside:avoid;padding:7px 0;border-bottom:1px solid var(--line);font-size:.86rem;color:var(--ink)}
.locker-list .muted{display:block;color:var(--muted);font-size:.78rem}
.content-section a{color:var(--ink)}
`;

function renderCityPage(c, related, shared) {
  const total = c.items.length;
  const url = `${SITE_URL}/${c.slug}`;
  const loc = LOCATIVE[c.slug];
  const title = loc
    ? `${c.name} pakiautomaadid – ${total} ${placesWord(total)} | Pakiautomaadid ${loc}`
    : `${c.name} pakiautomaadid – ${total} ${placesWord(total)} kaardil | Lähim pakiautomaat`;
  const description = loc
    ? `Pakiautomaadid ${loc}: ${total} ${placesWord(total)} (${carrierSummary(c)}). ${c.name} pakiautomaatide kaart ja nimekiri – leia lähim pakiautomaat.`
    : `${c.name} pakiautomaadid: ${total} ${placesWord(total)} (${carrierSummary(c)}). Vaata asukohti kaardil ja nimekirjas ning leia lähim pakiautomaat.`;
  const ledeIntro = loc
    ? `Pakiautomaate ja pakipunkte on ${loc} kokku ${total}: ${carrierSummary(c)}.`
    : `${c.name} asukohas on kokku ${total} pakiautomaati ja pakipunkti: ${carrierSummary(c)}.`;
  const present = SOURCE_ORDER.filter((s) => c.counts[s]);
  const withHours = c.items.filter((i) => i.hours);

  const mapData = c.items.map((i) => {
    const o = { s: i.source, n: i.name, a: Math.round(i.lat * 1e5) / 1e5, o: Math.round(i.lon * 1e5) / 1e5 };
    if (i.address) o.d = i.address;
    return o;
  });

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Lähim pakiautomaat", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: `${c.name} pakiautomaadid`, item: url },
    ],
  };

  const carrierSplit = present
    .map((s) => `<li><span class="badge ${s}">${esc(SOURCE_LABELS[s])}</span> ${c.counts[s]} ${placesWord(c.counts[s])}</li>`)
    .join("");

  const hoursSection = withHours.length
    ? `<h2>Asukohad, mille lahtiolekuaeg on teada</h2>
    <p>Postkontorid ja töötajatega pakipunktid on avatud kindlatel aegadel, erinevalt väliautomaatidest. Allpool on ${esc(c.name)} asukohad, mille lahtiolekuaeg vedaja andmetes olemas on.</p>
    <ul class="locker-list">${withHours
      .slice(0, 40)
      .map((i) => `<li><span class="badge ${i.source}">${esc(SOURCE_LABELS[i.source])}</span> <strong>${esc(i.name)}</strong>${i.address ? ` — ${esc(i.address)}` : ""}<span class="muted">${esc(i.hours)}</span></li>`)
      .join("")}</ul>`
    : "";

  const carrierSections = present
    .map((s) => {
      const list = c.items.filter((i) => i.source === s);
      return `<h2>${esc(SOURCE_LABELS[s])} asukohad: ${esc(c.name)} (${list.length})</h2>
    <ul class="locker-list">${list
      .map((i) => {
        const info = i.info && i.info.length <= 120 ? `<span class="muted">${esc(i.info)}</span>` : "";
        const hrs = i.hours ? `<span class="muted">${esc(i.hours)}</span>` : "";
        return `<li><strong>${esc(i.name)}</strong>${i.address ? ` — ${esc(i.address)}` : ""}${hrs}${info}</li>`;
      })
      .join("")}</ul>`;
    })
    .join("\n\n    ");

  const relatedSection = related.length
    ? `<h2>Pakiautomaadid lähedalasuvates linnades</h2>
    <nav class="city-links" aria-label="Lähedalasuvad linnad"><ul>${related
      .map((r) => `<li><a href="/${r.slug}">${esc(r.name)} (${r.items.length})</a></li>`)
      .join("")}</ul></nav>`
    : "";

  return `<!doctype html>
<html lang="et">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<script src="/theme-init.js"></script>
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>
${shared.css}${EXTRA_CSS}</style>
<script type="application/ld+json">${jsonForScript(breadcrumbLd)}</script>
</head>
<body>
<div class="wrap">

  <nav class="crumbs" aria-label="Asukoht lehel"><a href="/">Lähim pakiautomaat</a> › ${esc(c.name)}</nav>

  <header class="top">
    <h1>${esc(c.name)} pakiautomaadid</h1>
    <p class="lede">${esc(ledeIntro)} Siit näed need kõik ühel kaardil, et enne e-poes vedaja valimist kontrollida, kas sulle või saajale sobiv pakiautomaat on olemas. <a href="/">Otsi aadressi või nime järgi</a>, et leida lähim pakiautomaat täpselt oma asukoha ümber.</p>
  </header>

  <div id="map" role="img" aria-label="Kaart: ${esc(c.name)} pakiautomaadid"></div>
  <script type="application/json" id="city-data">${jsonForScript(mapData)}</script>

  <section class="content-section" aria-label="${esc(c.name)} pakiautomaatide nimekiri">
    <h2>Pakiautomaatide jaotus vedajate kaupa</h2>
    <ul class="carrier-split">${carrierSplit}</ul>

    ${hoursSection}

    ${carrierSections}

    ${relatedSection}

    <p class="note-updated">Andmed pärinevad vedajate avalikest asukohanimekirjadest, viimati uuendatud ${esc(today)}. Täpsema ja kõige värskema info leiad vedaja enda kodulehelt.</p>
  </section>

  <footer class="note">
    <p>Asukohaandmed: Omniva, DPD, Smartpost, Venipak, Unisend. Aadressiandmed: Maa- ja Ruumiamet. Kaart: &copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> contributors.</p>
    <p>Kaugused on sirgjoonelised. Asukohad ja tööajad võivad muutuda; kontrolli neid vedaja rakendusest. Kaubamärgid kuuluvad nende omanikele; leht ei ole vedajatega seotud.</p>
    <p><a href="/privaatsus.html">Privaatsus</a> &middot; <a href="/tingimused.html">Tingimused</a> &middot; <a href="/kontakt.html">Kontakt</a></p>
  </footer>
</div>
${shared.leafletTag}
<script src="/city-map.js"></script>
</body>
</html>
`;
}

function renderHomeLinks(cities) {
  const top = cities.slice(0, HOME_LINKS_COUNT);
  return `<nav class="city-links" aria-label="Pakiautomaadid linnade kaupa">
    <h2>Pakiautomaadid linnade kaupa</h2>
    <ul>${top.map((c) => `<li><a href="/${c.slug}">${esc(c.name)}</a></li>`).join("")}</ul>
  </nav>`;
}

function injectHomeLinks(cities) {
  const file = path.join(ROOT, "index.html");
  const html = fs.readFileSync(file, "utf8");
  const re = /<!--CITY-LINKS-START-->[\s\S]*?<!--CITY-LINKS-END-->/;
  if (!re.test(html)) {
    console.log("index.html: CITY-LINKS markereid ei leitud, avalehele linke ei lisatud.");
    return;
  }
  const next = html.replace(re, `<!--CITY-LINKS-START-->\n  ${renderHomeLinks(cities)}\n  <!--CITY-LINKS-END-->`);
  fs.writeFileSync(file, next);
}

// ---------- peaprogramm ----------
async function main() {
  const data = await loadData();
  const raw = Array.isArray(data.lockers) ? data.lockers : [];
  const { usableCount, cities: allCities } = groupByCity(raw);

  if (usableCount < MIN_TOTAL_LOCKERS) {
    throw new Error(`Kasutatavaid asukohti on vaid ${usableCount} (vähem kui ${MIN_TOTAL_LOCKERS}) — katkestan, et mitte avaldada tühje lehti.`);
  }

  const cities = allCities
    .filter((c) => c.items.length >= MIN_LOCKERS && !RESERVED_SLUGS.has(c.slug))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name, "et"));

  const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const cssMatch = indexHtml.match(/<style>([\s\S]*?)<\/style>/);
  const leafletMatch = indexHtml.match(/<script src="\/vendor\/leaflet\.js"><\/script>/);
  if (!cssMatch || !leafletMatch) throw new Error("index.html-ist ei leitud <style> plokki või Leafleti script-tagi.");
  const shared = { css: cssMatch[1], leafletTag: leafletMatch[0] };

  for (const c of cities) {
    const related = cities
      .filter((o) => o.slug !== c.slug)
      .map((o) => ({ o, d: distKm(c, o) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, RELATED_COUNT)
      .map((x) => x.o);
    fs.writeFileSync(path.join(ROOT, `${c.slug}.html`), renderCityPage(c, related, shared));
  }

  const urls = [`${SITE_URL}/`, ...cities.map((c) => `${SITE_URL}/${c.slug}`)];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);
  fs.writeFileSync(path.join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  injectHomeLinks(cities);

  // ---- aruanne (näitab ehituse logis, kas linnanimed on normaliseeritud mõistlikult) ----
  const small = allCities.length - cities.length;
  const covered = cities.reduce((s, c) => s + c.items.length, 0);
  console.log(`Asukohti kasutatavaid: ${usableCount} `);
  console.log(`Unikaalseid linnanimesid (normaliseeritult): ${allCities.length}`);
  console.log(`Lehti loodud: ${cities.length} (kriteerium: vähemalt ${MIN_LOCKERS} asukohta), katab ${covered} asukohta`);
  console.log(`Vähem kui ${MIN_LOCKERS} asukohaga, lehte ei saanud: ${small} linna`);
  console.log("Top 15:", cities.slice(0, 15).map((c) => `${c.name} ${c.items.length}`).join(", "));
  const merged = allCities.filter((c) => c.variants.size > 1);
  if (merged.length) {
    console.log("Kirjapildid, mis liideti ühe lehe alla:");
    for (const c of merged.slice(0, 15)) console.log(`  ${c.slug}: ${[...c.variants.keys()].join(" | ")}`);
  }
}

main().catch((err) => {
  console.error("Linnalehtede ehitus ebaõnnestus:", err.message);
  process.exit(1);
});
