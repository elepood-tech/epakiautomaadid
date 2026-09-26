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
 *
 * Endpointid:
 *   GET /lockers             -> kõik asukohad (Omniva + DPD + Smartpost), normaliseeritud
 *   GET /lockers?source=omniva
 *   GET /lockers?source=dpd
 *   GET /lockers?source=smartpost
 *   GET /geocode?text=...    -> aadressi geokodeerimine Maa-ameti API kaudu (samast põhjusest: CORS)
 */

const OMNIVA_URL = "https://www.omniva.ee/locations.json";
const DPD_URL = "https://dpdbaltics.com/PickupParcelShopData.json";
const SMARTPOST_URL = "https://my.smartpost.ee/api/places/";
const MAAAMET_GEOCODE_URL = "https://inaadress.maaamet.ee/geocoder-api/api/online";
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h — sama sagedusega kui allikad ise uuenevad

// Tõstetakse iga kord, kui /lockers vastuse KUJU muutub (uus allikas, väljade
// muudatus vms) — nii ei jää uus deploy kunagi kinni eelmise koodiversiooni
// puhverdatud (nt vigase) vastuse taha, kuna cache key muutub koos sellega.
const CACHE_VERSION = "v2";

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

    const source = url.searchParams.get("source"); // "omniva" | "dpd" | "smartpost" | null (kõik)
    const cacheUrl = new URL(url.toString());
    cacheUrl.searchParams.set("_cv", CACHE_VERSION);
    const cacheKey = new Request(cacheUrl.toString(), request);
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }

    const [omnivaResult, dpdResult, smartpostResult] = await Promise.all([
      source && source !== "omniva" ? { data: [], error: null } : fetchOmniva(),
      source && source !== "dpd" ? { data: [], error: null } : fetchDpd(),
      source && source !== "smartpost" ? { data: [], error: null } : fetchSmartpost(),
    ]);

    const body = JSON.stringify({
      updatedAt: new Date().toISOString(),
      count: omnivaResult.data.length + dpdResult.data.length + smartpostResult.data.length,
      omnivaCount: omnivaResult.data.length,
      dpdCount: dpdResult.data.length,
      smartpostCount: smartpostResult.data.length,
      errors: {
        omniva: omnivaResult.error,
        dpd: dpdResult.error,
        smartpost: smartpostResult.error,
      },
      lockers: [...omnivaResult.data, ...dpdResult.data, ...smartpostResult.data],
    });

    // Kui midagi nurjus, ära puhverda seda tulemust pikalt — proovi varsti uuesti.
    const anyError = omnivaResult.error || dpdResult.error || smartpostResult.error;
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
    const upstream = new URL(MAAAMET_GEOCODE_URL);
    upstream.searchParams.set("text", text);
    upstream.searchParams.set("output", "json");

    const res = await fetch(upstream.toString(), { headers: UPSTREAM_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const response = new Response(JSON.stringify({ error: null, result: data }), {
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
