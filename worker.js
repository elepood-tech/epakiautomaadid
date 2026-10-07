/**
 * Pakiautomaatide proxy — Cloudflare Worker
 *
 * Miks see on vajalik:
 * Omniva, DPD ja Smartpost avaldavad oma pakiautomaatide asukohad avalike
 * JSON-failidena, aga nende serverid ei saada CORS-päiseid, mistõttu brauser
 * blokeerib otsepäringu sinu veebilehelt. See worker teeb päringu serveri
 * poolelt (kus CORS-i reeglid ei kehti), normaliseerib andmed ühte kujuni ja
 * puhverdab (cache) tulemuse 24 tunniks, nii et allikate servereid ei
 * koormata iga külastaja peale.
 *
 * v2 muudatused:
 *   - Fetch-päringutele lisatud brauseri-taolised päised (User-Agent, Accept),
 *     kuna mõned serverid (nt DPD) blokeerivad päringuid, millel puudub
 *     tavaline brauseripäis.
 *   - Vastuse külge lisatud "errors" väli, mis näitab otse JSON-is, kas mõni
 *     allikas nurjus ja miks — ei pea Cloudflare logisid vaatama.
 * v3 muudatused:
 *   - Lisatud Smartpost (my.smartpost.ee) kolmanda andmeallikana.
 * v4 muudatused:
 *   - Lisatud Venipak (go.venipak.lt) neljanda andmeallikana.
 * v5 muudatused:
 *   - Lisatud Unisend/LP Express (api-esavitarna.post.lt) viienda andmeallikana.
 *     Nende avalik API nõuab korrektset Origin-päist (muidu "Origin header is
 *     missing" viga) — see on lihtsalt CORS-kontroll, mitte autentimine, ja
 *     me võltsime seda samamoodi nagu DPD juures User-Agent'i.
 * v6 muudatused:
 *   - "Viimase teadaoleva hea seisu" säilitamine Cloudflare KV-s (LOCKER_CACHE
 *     binding) allika kaupa. Kui mõni allikas ebaõnnestub (link muutus,
 *     server ajutiselt maas), kasutame KV-s salvestatud viimaseid häid
 *     andmeid selle asemel, et kukkuda tagasi väikesele sisseehitatud
 *     näidiskomplektile — vt withLastKnownGood().
 * v7 muudatused:
 *   - Bugifix: kui mõni allikas ei vastanud, ei puhverdatud /lockers vastust
 *     ÜLDSE (`if (!anyError)` kaitses cache.put'i), mistõttu iga külastaja
 *     päring käivitas päringu uuesti KÕIGI viie allika poole, mitte ainult
 *     selle ühe katkise vastu — seni kuni allikas taastus. Nüüd puhverdatakse
 *     ka veaga vastus, lihtsalt lühemaks ajaks (vt browserMaxAge/edgeMaxAge),
 *     nii et katkise allika poole proovitakse uuesti kõige rohkem korra
 *     iga paari minuti jooksul, mitte iga külastaja kohta eraldi.
 *   - Andmete uuendussagedus 24h -> 7 päeva (allikad ei muutu tihti),
 *     katkise allika taasproovimine 5 min -> 2x nädalas (ERROR_RETRY_SECONDS).
 *   - fetchUnisend() PEATATUD: nende terminalinimekiri nõudis Origin/Referer
 *     päist, mille me võltsisime kui oleks nende enda leht — see pole
 *     korrektne ligipääs ilma nende loata, seega me ei tee enam sellele
 *     URL-ile otsepäringut. Varem kogutud andmed jäävad KV kaudu lehele
 *     nähtavaks (punase chipina), kuni saame loa või ametliku API.
 *
 * Endpointid:
 *   GET /lockers             -> kõik asukohad (Omniva + DPD + Smartpost + Venipak + Unisend), normaliseeritud
 *   GET /lockers?source=omniva
 *   GET /lockers?source=dpd
 *   GET /lockers?source=smartpost
 *   GET /lockers?source=venipak
 *   GET /lockers?source=unisend
 *   GET /geocode?text=...    -> aadressi geokodeerimine Maa-ameti API kaudu (samast põhjusest: CORS)
 */

const OMNIVA_URL = "https://www.omniva.ee/locations.json";
const DPD_URL = "https://dpdbaltics.com/PickupParcelShopData.json";
const SMARTPOST_URL = "https://my.smartpost.ee/api/places/";
const VENIPAK_URL = "https://go.venipak.lt/ws/get_pickup_points";
const UNISEND_URL = "https://api-esavitarna.post.lt/terminal/list/csv";
const MAAAMET_GEOCODE_URL = "https://inaadress.maaamet.ee/geocoder-api/api/online";
// Katsetasime ka "/api/plain" (sama avalik teenus, mida kasutab
// inaadress.maaamet.ee enda otsingukast) lootuses saada mitu kandidaati
// tekstide jaoks nagu "Narva mnt 5" (ilma linnata). Kontrollitud: MÕLEMAD
// otsad valivad ise ühe "parima" aadressi (nt alati Tallinna oma) ega
// tagasta kunagi teiste linnade samanimelisi tänavaid — see on Maa-ameti
// teenuse enda sisemine otsus, mitte midagi, mida meie saame mõjutada.
// "/api/plain" tagastab endiselt struktuurse "group.rows" massiivi (harvadel
// juhtudel, kui Maa-amet ISE peab tulemust mitmeseks, on seal >1 kirjet),
// nii et jätsime selle esmaseks otsaks — kasutajaliideses näidatav
// "Leitud: ..." tekst sisaldab alati valitud linna/valda, et kasutaja
// näeks kohe, kas asukoht klapib, ja saaks vajadusel linnanimega täpsustada.
const MAAAMET_PLAIN_URL = "https://inaadress.maaamet.ee/geocoder-api/api/plain";
// Vedajate asukohtade nimekirjad ei muutu tihti, seega piisab kord nädalas
// uuendamisest. Kui mõni allikas parasjagu ei vasta, proovime seda
// uuesti tihedamini — kaks korda nädalas (pool nädalase TTL-ist) — kuni
// see taastub.
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // kord nädalas
const ERROR_RETRY_SECONDS = Math.round(CACHE_TTL_SECONDS / 2); // kaks korda nädalas

// Tõstetakse iga kord, kui /lockers vastuse KUJU muutub (uus allikas, väljade
// muudatus vms) — nii ei jää uus deploy kunagi kinni eelmise koodiversiooni
// puhverdatud (nt vigase) vastuse taha, kuna cache key muutub koos sellega.
const CACHE_VERSION = "v12";
// Linnalehtede build'i minimaalne vahe (deploy hook, vt triggerSiteRebuild).
const MIN_REBUILD_INTERVAL_SECONDS = 5 * 24 * 60 * 60;

// Ainult meie enda lehele lubatud (mitte "*"), et keegi teine ei saaks seda
// worker'it (ja meie Cloudflare arvestust) oma lehele "laenata". Kui lisandub
// oma domeen (mitte *.pages.dev), tuleb see siia samuti lisada.
const ALLOWED_ORIGIN = "https://epakiautomaadid.pages.dev";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
};

// Brauseri-taolised päised — mõned serverid (DPD) blokeerivad päringuid ilma nendeta.
const UPSTREAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/geocode") {
      return handleGeocode(url, ctx);
    }

    if (url.pathname !== "/lockers") {
      return new Response(JSON.stringify({ error: "Tundmatu tee. Kasuta /lockers või /geocode" }), {
        status: 404,
        headers: CORS_HEADERS,
      });
    }

    const source = url.searchParams.get("source"); // "omniva" | "dpd" | "smartpost" | "venipak" | null (kõik)
    const cacheUrl = new URL(url.toString());
    cacheUrl.searchParams.set("_cv", CACHE_VERSION);
    const cacheKey = new Request(cacheUrl.toString(), request);
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }

    const [omnivaResult, dpdResult, smartpostResult, venipakResult, unisendResult] = await Promise.all([
      source && source !== "omniva" ? { data: [], error: null } : withLastKnownGood("omniva", fetchOmniva, env, ctx),
      source && source !== "dpd" ? { data: [], error: null } : withLastKnownGood("dpd", fetchDpd, env, ctx),
      source && source !== "smartpost"
        ? { data: [], error: null }
        : withLastKnownGood("smartpost", fetchSmartpost, env, ctx),
      source && source !== "venipak"
        ? { data: [], error: null }
        : withLastKnownGood("venipak", fetchVenipak, env, ctx),
      source && source !== "unisend"
        ? { data: [], error: null }
        : withLastKnownGood("unisend", fetchUnisend, env, ctx),
    ]);

    const body = JSON.stringify({
      updatedAt: new Date().toISOString(),
      count:
        omnivaResult.data.length +
        dpdResult.data.length +
        smartpostResult.data.length +
        venipakResult.data.length +
        unisendResult.data.length,
      omnivaCount: omnivaResult.data.length,
      dpdCount: dpdResult.data.length,
      smartpostCount: smartpostResult.data.length,
      venipakCount: venipakResult.data.length,
      unisendCount: unisendResult.data.length,
      errors: {
        omniva: omnivaResult.error,
        dpd: dpdResult.error,
        smartpost: smartpostResult.error,
        venipak: venipakResult.error,
        unisend: unisendResult.error,
      },
      // true, kui see allikas hetkel tegelikult ebaõnnestus ja kuvatavad
      // andmed pärinevad KV-sse salvestatud viimasest heast seisust, mitte
      // värskest päringust.
      stale: {
        omniva: !!(omnivaResult.error && omnivaResult.recovered),
        dpd: !!(dpdResult.error && dpdResult.recovered),
        smartpost: !!(smartpostResult.error && smartpostResult.recovered),
        venipak: !!(venipakResult.error && venipakResult.recovered),
        unisend: !!(unisendResult.error && unisendResult.recovered),
      },
      lockers: [
        ...omnivaResult.data,
        ...dpdResult.data,
        ...smartpostResult.data,
        ...venipakResult.data,
        ...unisendResult.data,
      ],
    });

    // Kui midagi nurjus, ära puhverda seda tulemust pikalt — proovi varsti uuesti.
    const anyError =
      omnivaResult.error || dpdResult.error || smartpostResult.error || venipakResult.error || unisendResult.error;

    // TÄHELEPANU: "Cache-Control" siin läheb otse KASUTAJA BRAUSERISSE, mitte
    // ainult Cloudflare edge cache'ile. Kui see oleks 24h (nagu CACHE_TTL_SECONDS),
    // jääks brauser vana /lockers vastust kasutama kuni 24h — sõltumata meie
    // deploy'dest või CACHE_VERSION muutumisest. See oligi tegelik põhjus,
    // miks Omniva postkontorite avatud aja parandus mõnes brauseris kohale
    // ei jõudnud, kuigi worker ja index.html olid juba õigesti deploy'tud.
    // Lahendus: brauserile lühike max-age (paar minutit), Cloudflare edge'i
    // (kõigi külastajate vahel jagatud, päris 24h) jaoks eraldi
    // "Cloudflare-CDN-Cache-Control" päis, mida brauserid ignoreerivad.
    const browserMaxAge = anyError ? 30 : 120;
    const edgeMaxAge = anyError ? ERROR_RETRY_SECONDS : CACHE_TTL_SECONDS;

    const response = new Response(body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": `public, max-age=${browserMaxAge}`,
        "Cloudflare-CDN-Cache-Control": `public, max-age=${edgeMaxAge}`,
      },
    });

    // Puhverdame ka vea korral (lühikeseks ajaks, vt ERROR_RETRY_SECONDS
    // ülal) — muidu läheks IGA külastaja päring otse kõigi viie allika
    // poole uuesti, seni kuni üks neist ei vasta. Nii proovitakse katkise
    // allika poole uuesti kõige rohkem korra iga edgeMaxAge jooksul
    // (vaikimisi kaks korda nädalas), mitte iga külastaja kohta eraldi.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    // Linnalehed (SEO) ehitatakse Cloudflare Pages'i build'i käigus nende
    // andmete põhjal. Kui oleme just tõmmanud värsked andmed, käivitame
    // uue build'i. Unisend on pausil ja annab alati vea, seetõttu ei arvesta
    // me seda; päring ühe allikaga (?source=) ei ole täisandmestik.
    if (!source) {
      const freshOk = !omnivaResult.error && !dpdResult.error && !smartpostResult.error && !venipakResult.error;
      if (freshOk) ctx.waitUntil(triggerSiteRebuild(env));
    }

    return response;
  },
};

// Käivitab Pages'i deploy hook'i, kuid mitte tihedamini kui
// MIN_REBUILD_INTERVAL_SECONDS (KV märge). Hook'i URL on salajane ja asub
// Workeri saladuses DEPLOY_HOOK_URL — koodis ega GitHubis seda pole.
// Kui saladust või KV-d pole, ei tee see midagi.
async function triggerSiteRebuild(env) {
  const hookUrl = env && env.DEPLOY_HOOK_URL;
  const kv = env && env.LOCKER_CACHE;
  if (!hookUrl || !kv) return;
  const KEY = "rebuild:last";
  try {
    const last = Number(await kv.get(KEY)) || 0;
    if (Date.now() - last < MIN_REBUILD_INTERVAL_SECONDS * 1000) return;
    // Märge enne päringut, et samaaegsed külastajad ei käivitaks mitut build'i.
    await kv.put(KEY, String(Date.now()));
    const res = await fetch(hookUrl, { method: "POST" });
    if (!res.ok) {
      await kv.delete(KEY); // luba hiljem uuesti proovida
      console.log("Deploy hook ebaõnnestus: HTTP " + res.status);
    }
  } catch (err) {
    try { await kv.delete(KEY); } catch (_) { /* ignoreeri */ }
    console.log("Deploy hook viga: " + (err && err.message));
  }
}

// Kutsub allika fetch-funktsiooni. Kui see õnnestub ja annab andmeid, salvestab
// tulemuse Cloudflare KV-sse "viimase teadaoleva hea seisuna". Kui see
// ebaõnnestub (viga või tühi tulemus), proovib KV-st lugeda eelmise õnnestunud
// laadimise andmed ja kasutab neid selle asemel, et tagasi langeda väikesele
// sisseehitatud näidiskomplektile.
async function withLastKnownGood(sourceName, fetchFn, env, ctx) {
  const result = await fetchFn(env);
  const kv = env && env.LOCKER_CACHE;

  if (!result.error && result.data.length) {
    if (kv) {
      const payload = JSON.stringify({ data: result.data, savedAt: new Date().toISOString() });
      ctx.waitUntil(kv.put(`last:${sourceName}`, payload));
    }
    return result;
  }

  if (kv) {
    try {
      const stored = await kv.get(`last:${sourceName}`, "json");
      if (stored && Array.isArray(stored.data) && stored.data.length) {
        return { data: stored.data, error: result.error || "KV varukoopia", recovered: true, savedAt: stored.savedAt };
      }
    } catch (e) {
      // KV lugemine ebaõnnestus — jätkame allolevat tavapärast tagasilangemist.
    }
  }

  return result;
}

async function handleGeocode(url, ctx) {
  const text = url.searchParams.get("text");
  if (!text) {
    return new Response(JSON.stringify({ error: "Puudub 'text' parameeter" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const cacheKey = new Request(url.toString());
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    let rows = await fetchPlainCandidates(text);

    // "/api/plain" annab harva vahel tühja tulemuse (nt väga lühikese või
    // ebatavalise sisendi korral) kuigi "/api/online" leiaks midagi — sel
    // juhul langeme tagasi selle peale, et kasutaja saaks vähemalt ühe vaste.
    if (!rows.length) {
      const upstream = new URL(MAAAMET_GEOCODE_URL);
      upstream.searchParams.set("text", text);
      upstream.searchParams.set("output", "json");
      const res = await fetch(upstream.toString(), { headers: UPSTREAM_HEADERS });
      if (res.ok) {
        const data = await res.json();
        rows = data ? [data] : [];
      }
    }

    const response = new Response(JSON.stringify({ error: null, result: rows }), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "public, max-age=86400", // aadressid ei muutu, võib kaua puhverdada
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err && err.message ? err.message : err), result: null }),
      { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
    );
  }
}

async function fetchPlainCandidates(text) {
  const res = await fetch(MAAAMET_PLAIN_URL, {
    method: "POST",
    headers: { ...UPSTREAM_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ address: text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const rows = data && data.group && Array.isArray(data.group.rows) ? data.group.rows : [];
  return rows.filter((r) => r && typeof r.b !== "undefined" && typeof r.l !== "undefined");
}

async function fetchOmniva() {
  try {
    const res = await fetch(OMNIVA_URL, {
      headers: UPSTREAM_HEADERS,
      cf: { cacheTtl: CACHE_TTL_SECONDS },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.data || [];
    const out = list
      // Omniva locations.json on ühine kõigile kolmele Balti riigile (A0_NAME
      // on riigikood) — filtreerime Eestile, et olla järjekindel teiste nelja
      // allikaga, mis kõik juba näitavad ainult Eestit.
      .filter((r) => !r.A0_NAME || r.A0_NAME === "EE")
      .map((r) => {
        const lat = parseFloat(r.Y_COORDINATE ?? r.y_coordinate);
        const lon = parseFloat(r.X_COORDINATE ?? r.x_coordinate);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        // Omniva andmestikus on TYPE "0" = pakiautomaat (õues, avatud aeg
        // ebaoluline) ja TYPE "1" = postkontor (töötajatega, päris
        // lahtiolekuaeg SERVICE_HOURS/TEMP_SERVICE_HOURS väljal). Näitame
        // avatud aega ainult postkontoritel, mitte kunagi automaatidel.
        const isPostOffice = r.TYPE === "1";
        const rawHours = String(r.TEMP_SERVICE_HOURS || r.SERVICE_HOURS || "").trim();
        const rawComment = String(r.comment_est || "").trim();
        return {
          source: "omniva",
          name: r.NAME ?? "Omniva asukoht",
          street: null,
          city: r.A2_NAME ?? null,
          county: r.A1_NAME ?? null,
          zip: r.ZIP ?? null,
          hours: isPostOffice && rawHours ? rawHours : null,
          locationInfo: isPostOffice && rawComment ? rawComment : null,
          lat,
          lon,
        };
      })
      .filter(Boolean);
    return { data: out, error: null };
  } catch (err) {
    return { data: [], error: String(err && err.message ? err.message : err) };
  }
}

async function fetchDpd() {
  try {
    const res = await fetch(DPD_URL, {
      headers: UPSTREAM_HEADERS,
      cf: { cacheTtl: 0, cacheEverything: false }, // ei puhvertata päritolu poolel — vältimaks vana tühja vastuse kinnijäämist
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.data || [];
    const out = list
      .filter((r) => !r.countryCode || r.countryCode === "EE")
      .map((r) => {
        const lat = parseFloat(r.latitude);
        const lon = parseFloat(r.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          source: "dpd",
          name: r.companyShortName ?? r.companyName ?? "DPD asukoht",
          street: [r.street, r.houseNo].filter(Boolean).join(" ") || null,
          city: r.city ?? null,
          county: null,
          zip: r.zipCode ?? null,
          lat,
          lon,
        };
      })
      .filter(Boolean);
    return { data: out, error: null };
  } catch (err) {
    return { data: [], error: String(err && err.message ? err.message : err) };
  }
}

// Venipak "working_hours" on JSON-stringina kodeeritud massiiv päevade kaupa
// (dayOfWeek 1=E...7=P, openTime/closeTime). Enamik automaate on avatud
// ööpäevaringselt (00:00-23:59 kõik päevad) — sellisel juhul ei näita me
// midagi, kuna kasutajale on see teave kasutu (vt. index.html samast otsusest
// Omniva/DPD kohta). Näitame ainult siis, kui mõni päev on tegelikult piiratud.
const WEEKDAY_LABELS = { 1: "E", 2: "T", 3: "K", 4: "N", 5: "R", 6: "L", 7: "P" };

function formatVenipakHours(raw) {
  if (!raw) return null;
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(arr) || !arr.length) return null;

  const isFullDay = (d) => d.openTime === "00:00" && d.closeTime === "23:59";
  if (arr.every(isFullDay)) return null; // ööpäevaringne — pole vaja näidata

  return arr
    .slice()
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((d) => (WEEKDAY_LABELS[d.dayOfWeek] || "?") + " " + d.openTime + "-" + d.closeTime)
    .join(", ");
}

async function fetchVenipak() {
  try {
    const res = await fetch(VENIPAK_URL, {
      headers: UPSTREAM_HEADERS,
      cf: { cacheTtl: CACHE_TTL_SECONDS },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.data || [];
    const out = list
      .filter((r) => !r.country || r.country === "EE")
      .map((r) => {
        const lat = parseFloat(r.lat);
        const lon = parseFloat(r.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          source: "venipak",
          name: r.display_name || r.name || "Venipak asukoht",
          street: r.address || null,
          city: r.city || null,
          county: null,
          zip: r.zip || null,
          hours: formatVenipakHours(r.working_hours),
          locationInfo: r.description || null,
          lat,
          lon,
        };
      })
      .filter(Boolean);
    return { data: out, error: null };
  } catch (err) {
    return { data: [], error: String(err && err.message ? err.message : err) };
  }
}

// Lihtne CSV parser, mis oskab jutumärkides välju (mis võivad sisaldada koma).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx]; });
    return obj;
  });
}

// ---------- Unisend (LP Express) ametlik API ----------
// Dokumentatsioon: https://www.post.lt/savitarna/api_doc.html
// Kasutaja ja parool on Cloudflare'i secretid (UNISEND_USER, UNISEND_PASS),
// mitte repos. Seadista: `wrangler secret put UNISEND_USER` / `UNISEND_PASS`.
// NB! Unisendi tulemüür blokeerib brauseri-taolise User-Agent'i, seega
// siin kasutame eraldi, mitte-brauseri User-Agent'i (mitte UPSTREAM_HEADERS).
const UNISEND_API_BASE = "https://api-manosiuntos.post.lt";
const UNISEND_TERMINAL_PATH = "/api/v2/terminal";
const UNISEND_UA = "epakiautomaadid/1.0";
// 5 vale sisselogimist blokeerivad konto 15 min, seega ebaõnnestunud
// sisselogimist ei korda enne selle ajani.
const UNISEND_LOGIN_BACKOFF_SECONDS = 20 * 60;

async function unisendToken(env) {
  const kv = env && env.LOCKER_CACHE;
  if (kv) {
    const cached = await kv.get("unisend:token", "json");
    if (cached && cached.token && cached.expiresAt > Date.now() + 60000) return cached.token;
    const blocked = await kv.get("unisend:login-blocked");
    if (blocked) throw new Error("Unisend sisselogimine ebaõnnestus hiljuti, ootan enne uut katset");
  }
  const url = new URL(UNISEND_API_BASE + "/oauth/token");
  url.searchParams.set("grant_type", "password");
  url.searchParams.set("username", env.UNISEND_USER);
  url.searchParams.set("password", env.UNISEND_PASS);
  url.searchParams.set("scope", "read+write+API_CLIENT");
  // URLSearchParams kodeerib '+' kui %2B — sama kuju on dokumentatsiooni näites.
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "User-Agent": UNISEND_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    if (kv) await kv.put("unisend:login-blocked", "1", { expirationTtl: UNISEND_LOGIN_BACKOFF_SECONDS });
    throw new Error(`Unisend sisselogimine: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body || !body.access_token) throw new Error("Unisend sisselogimine: vastuses puudub access_token");
  const ttl = Number(body.expires_in) || 3600;
  if (kv) {
    await kv.put(
      "unisend:token",
      JSON.stringify({ token: body.access_token, expiresAt: Date.now() + ttl * 1000 }),
      { expirationTtl: Math.max(60, ttl - 60) }
    );
  }
  return body.access_token;
}

// Vastuse väljanimed ei ole dokumentatsioonis kirjas, seega loeme mitut
// tõenäolist nime. Kui koordinaate ei leita, tagastame veateate koos
// esimese kirje võtmetega, et saaksime mappingu parandada.
function pick(o, keys) {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return null;
}

// Unisend kinnitas kirjalikult (07.10.2026), et ilma API-ta saab kasutada nende
// avalikku CSV-faili (my.unisend.ee/map), ja API on lepinguklientidele.
// Seega: kui secretid on, kasutame API-t; muidu (või kui API ebaõnnestub)
// proovime avalikku CSV-d. Päringul EI ole võltsitud Origin/Referer päiseid;
// kui server neid nõuab, tuleb Unisendilt küsida otsest allalaadimislinki.
async function fetchUnisend(env) {
  const haveCreds = !!(env && env.UNISEND_USER && env.UNISEND_PASS);
  if (haveCreds) {
    const viaApi = await fetchUnisendApi(env);
    if (!viaApi.error) return viaApi;
    const viaCsv = await fetchUnisendCsv();
    return viaCsv.error ? { data: [], error: viaApi.error + " | CSV: " + viaCsv.error } : viaCsv;
  }
  return fetchUnisendCsv();
}

async function fetchUnisendCsv() {
  try {
    const res = await fetch(UNISEND_URL, {
      headers: { "User-Agent": UNISEND_UA, Accept: "text/csv,*/*" },
      cf: { cacheTtl: CACHE_TTL_SECONDS },
    });
    if (!res.ok) throw new Error(`Unisend CSV: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const rows = parseCsv(await res.text());
    const out = rows
      .filter((r) => !r.countryCode || r.countryCode === "EE")
      .map((r) => {
        const lat = parseFloat(r.latitude);
        const lon = parseFloat(r.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          source: "unisend",
          name: r.name || "Unisend asukoht",
          street: r.address || null,
          city: r.city || null,
          county: null,
          zip: r.postalCode || null,
          hours: null,
          locationInfo: r.comment || null,
          lat,
          lon,
        };
      })
      .filter(Boolean);
    if (!out.length) throw new Error("Unisend CSV: ei leidnud kasutatavaid kirjeid");
    return { data: out, error: null };
  } catch (err) {
    return { data: [], error: String(err && err.message ? err.message : err) };
  }
}

async function fetchUnisendApi(env) {
  try {
    const token = await unisendToken(env);
    const res = await fetch(UNISEND_API_BASE + UNISEND_TERMINAL_PATH + "?receiverCountryCode=EE", {
      headers: { "User-Agent": UNISEND_UA, Accept: "application/json", "Accept-Language": "et", Authorization: "Bearer " + token },
    });
    if (!res.ok) throw new Error(`Unisend terminalid: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.content || data?.data || data?.terminals || data?.items || [];
    const out = list
      .filter((r) => {
        const c = pick(r, ["countryCode", "country", "country_code"]);
        return !c || String(c).toUpperCase() === "EE";
      })
      .map((r) => {
        const lat = parseFloat(pick(r, ["latitude", "lat", "y"]) ?? pick(r.coordinates || r.location || {}, ["latitude", "lat", "y"]));
        const lon = parseFloat(pick(r, ["longitude", "lng", "lon", "x"]) ?? pick(r.coordinates || r.location || {}, ["longitude", "lng", "lon", "x"]));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          source: "unisend",
          name: pick(r, ["name", "title", "displayName"]) || "Unisend asukoht",
          street: pick(r, ["address", "street", "addressLine"]),
          city: pick(r, ["city", "locality", "town"]),
          county: null,
          zip: pick(r, ["postalCode", "zip", "postcode"]),
          hours: null,
          locationInfo: pick(r, ["comment", "description", "locationInfo"]),
          lat,
          lon,
        };
      })
      .filter(Boolean);
    if (!out.length) {
      const sample = list[0] ? Object.keys(list[0]).join(",") : "tühi vastus";
      throw new Error("Unisend: ei leidnud kasutatavaid kirjeid (esimese kirje väljad: " + sample + ")");
    }
    return { data: out, error: null };
  } catch (err) {
    return { data: [], error: String(err && err.message ? err.message : err) };
  }
}

async function fetchSmartpost() {
  try {
    const res = await fetch(SMARTPOST_URL, {
      headers: UPSTREAM_HEADERS,
      cf: { cacheTtl: CACHE_TTL_SECONDS },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.places || data?.data || data?.results || [];
    const out = list
      .filter((r) => !r.address_country_code || r.address_country_code.toLowerCase() === "ee")
      .map((r) => {
        const lat = parseFloat(r.address_latitude);
        const lon = parseFloat(r.address_longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          source: "smartpost",
          name: r.name ?? "Smartpost asukoht",
          street: [r.address_street, r.address_house].filter(Boolean).join(" ") || null,
          city: r.address_city ?? r.region ?? null,
          county: null,
          zip: r.address_zip ?? null,
          hours: r.availability_info || null,
          locationInfo: r.location_info || null,
          lat,
          lon,
        };
      })
      .filter(Boolean);
    return { data: out, error: null };
  } catch (err) {
    return { data: [], error: String(err && err.message ? err.message : err) };
  }
}
