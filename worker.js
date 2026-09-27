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
// "/api/online" tagastab Maa-ameti enda "parima pakkumise" — ainult ühe
// aadressi, isegi kui tekst (nt "Narva mnt 5" ilma linnata) sobib mitmele
// kohale. "/api/plain" on sama avalik teenus, mida kasutab ka
// inaadress.maaamet.ee enda otsingukast, ja tagastab KÕIK sobivad
// kandidaadid (group.rows), nii et saame kasutajale valiku pakkuda.
const MAAAMET_PLAIN_URL = "https://inaadress.maaamet.ee/geocoder-api/api/plain";
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h — sama sagedusega kui allikad ise uuenevad

// Tõstetakse iga kord, kui /lockers vastuse KUJU muutub (uus allikas, väljade
// muudatus vms) — nii ei jää uus deploy kunagi kinni eelmise koodiversiooni
// puhverdatud (nt vigase) vastuse taha, kuna cache key muutub koos sellega.
const CACHE_VERSION = "v8";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // production: vaheta oma domeeni vastu
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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
    const maxAge = anyError ? 300 : CACHE_TTL_SECONDS;

    const response = new Response(body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": `public, max-age=${maxAge}`,
      },
    });

    if (!anyError) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};

// Kutsub allika fetch-funktsiooni. Kui see õnnestub ja annab andmeid, salvestab
// tulemuse Cloudflare KV-sse "viimase teadaoleva hea seisuna". Kui see
// ebaõnnestub (viga või tühi tulemus), proovib KV-st lugeda eelmise õnnestunud
// laadimise andmed ja kasutab neid selle asemel, et tagasi langeda väikesele
// sisseehitatud näidiskomplektile.
async function withLastKnownGood(sourceName, fetchFn, env, ctx) {
  const result = await fetchFn();
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
        return {
          source: "omniva",
          name: r.NAME ?? "Omniva asukoht",
          street: null,
          city: r.A2_NAME ?? null,
          county: r.A1_NAME ?? null,
          zip: r.ZIP ?? null,
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

async function fetchUnisend() {
  try {
    // Nende avalik terminalinimekiri nõuab korrektset Origin/Referer päist
    // (sama tehnika, mis DPD User-Agent'i puhul — CORS-kontroll, mitte
    // autentimine: ilma selleta annab "Origin header is missing" vea).
    const res = await fetch(UNISEND_URL, {
      headers: { ...UPSTREAM_HEADERS, Origin: "https://my.unisend.ee", Referer: "https://my.unisend.ee/" },
      cf: { cacheTtl: CACHE_TTL_SECONDS },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
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
          // Unisendi kirjed on väliautomaadid (nagu teisedki peale Smartposti),
          // seega avatud aeg pole oluline. "comment" väli on ka läbivalt
          // samasugune leedukeelne üldtekst, mitte konkreetse asukoha
          // kirjeldus, seega ei näita seda kasutajale.
          hours: null,
          locationInfo: null,
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
