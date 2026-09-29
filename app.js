(function(){
  "use strict";

  var WORKER_URL = "https://epakiautomaadid.roolikatted.workers.dev/lockers";
  var WORKER_GEOCODE_URL = "https://epakiautomaadid.roolikatted.workers.dev/geocode";

  var state = { omniva: null, dpd: null, smartpost: null, venipak: null, unisend: null, userPoint: null, carrierFilter: null, exactMatches: [] };

  // Väike käsitsi kogutud valim päris Omniva locations.json kirjetest (26.09.2026 seisuga).
  // Väli-nimed on jäetud samaks, mis päris API-l, et normaliseerimisfunktsioon jääks muutumatuks.
  var OMNIVA_SAMPLE_DATA = [
    { ZIP:"11701", NAME:"Arsenali postkontor", TYPE:"1", A1_NAME:"Harju maakond", A2_NAME:"Tallinn", X_COORDINATE:"24.717816", Y_COORDINATE:"59.451722" },
    { ZIP:"50600", NAME:"Eedeni postkontor", TYPE:"1", A1_NAME:"Tartu maakond", A2_NAME:"Tartu linn", X_COORDINATE:"26.748826", Y_COORDINATE:"58.373434" },
    { ZIP:"96238", NAME:"Audru osavallakeskuse pakiautomaat", TYPE:"0", A1_NAME:"Pärnu maakond", A2_NAME:"Pärnu linn", X_COORDINATE:"24.356026", Y_COORDINATE:"58.407879" },
    { ZIP:"96328", NAME:"Are pakiautomaat", TYPE:"0", A1_NAME:"Pärnu maakond", A2_NAME:"Tori vald", X_COORDINATE:"24.564522", Y_COORDINATE:"58.518677" },
    { ZIP:"96287", NAME:"Alatskivi Coop Konsumi pakiautomaat", TYPE:"0", A1_NAME:"Tartu maakond", A2_NAME:"Peipsiääre vald", X_COORDINATE:"27.132467", Y_COORDINATE:"58.600633" },
    { ZIP:"96179", NAME:"Elva Arbimäe Coop Konsumi pakiautomaat", TYPE:"0", A1_NAME:"Tartu maakond", A2_NAME:"Elva vald", X_COORDINATE:"26.414144", Y_COORDINATE:"58.234123" },
    { ZIP:"96047", NAME:"Elva Turuplatsi Coop Konsumi pakiautomaat", TYPE:"0", A1_NAME:"Tartu maakond", A2_NAME:"Elva vald", X_COORDINATE:"26.408822", Y_COORDINATE:"58.221047" },
    { ZIP:"96280", NAME:"Aegviidu Meie kaupluse pakiautomaat", TYPE:"0", A1_NAME:"Harju maakond", A2_NAME:"Anija vald", X_COORDINATE:"25.606367", Y_COORDINATE:"59.288383" },
    { ZIP:"96465", NAME:"Alliku pakiautomaat", TYPE:"0", A1_NAME:"Harju maakond", A2_NAME:"Saue vald", X_COORDINATE:"24.590392", Y_COORDINATE:"59.368121" },
    { ZIP:"96204", NAME:"Aruküla Coop Konsumi pakiautomaat", TYPE:"0", A1_NAME:"Harju maakond", A2_NAME:"Raasiku vald", X_COORDINATE:"25.078314", Y_COORDINATE:"59.370973" }
  ];

  // Väike käsitsi kogutud valim päris DPD dpdbaltics.com/PickupParcelShopData.json kirjetest (26.09.2026 seisuga).
  var DPD_SAMPLE_DATA = [
    { parcelShopType:"PickupStation", zipCode:"17008", city:"TALLINN", companyShortName:"Automaat Tallinna Mustamäe keskus", street:"A. H. Tammsaare tee 104a", countryCode:"EE", latitude:"59.40842", longitude:"24.68807" },
    { parcelShopType:"PickupStation", zipCode:"17015", city:"TALLINN", companyShortName:"Automaat Tallinna MustakiviSelver", street:"Mustakivi tee 3a", countryCode:"EE", latitude:"59.437985", longitude:"24.870307" },
    { parcelShopType:"PickupStation", zipCode:"10913", city:"TALLINN", companyShortName:"Automaat Pääsküla Realkeskus", street:"Pärnu mnt 421", countryCode:"EE", latitude:"59.36921691", longitude:"24.63866214" },
    { parcelShopType:"PickupStation", zipCode:"11913", city:"TALLINN", companyShortName:"Automaat Tallinna Mähe Grossi", street:"Randvere tee 115a", countryCode:"EE", latitude:"59.4912333", longitude:"24.8795233" },
    { parcelShopType:"PickupStation", zipCode:"10916", city:"TALLINN", companyShortName:"Automaat Tallinna Pääsküla Rimi", street:"Pärnu mnt 453e", countryCode:"EE", latitude:"59.360973", longitude:"24.630409" },
    { parcelShopType:"PickupStation", zipCode:"13914", city:"TALLINN", companyShortName:"Automaat Tallinna Priisle Selver", street:"Priisle tee 1", countryCode:"EE", latitude:"59.45444", longitude:"24.88542" },
    { parcelShopType:"PickupStation", zipCode:"11417", city:"TALLINN", companyShortName:"Automaat Tallinna Paepargi Maxima", street:"Paepargi 57", countryCode:"EE", latitude:"59.43531", longitude:"24.811441" },
    { parcelShopType:"PickupStation", zipCode:"13424", city:"TALLINN", companyShortName:"Automaat Tallinna Sõpruse Rimi", street:"Sõpruse pst 174", countryCode:"EE", latitude:"59.414748", longitude:"24.707221" },
    { parcelShopType:"PickupStation", zipCode:"13519", city:"TALLINN", companyShortName:"Automaat Tallinna Astangu Maxima", street:"Astangu 27a", countryCode:"EE", latitude:"59.405185", longitude:"24.638352" },
    { parcelShopType:"PickupStation", zipCode:"11911", city:"TALLINN", companyShortName:"Automaat Tallinna Pirita Selver", street:"Rummu tee 4", countryCode:"EE", latitude:"59.46275", longitude:"24.82696" },
    { parcelShopType:"PickupStation", zipCode:"13620", city:"TALLINN", companyShortName:"Automaat Tallinna Pae Rimi", street:"Pae 76", countryCode:"EE", latitude:"59.43618", longitude:"24.82159" },
    { parcelShopType:"PickupStation", zipCode:"10315", city:"TALLINN", companyShortName:"Automaat Tallinna Stroomi keskus", street:"Tuulemaa 20", countryCode:"EE", latitude:"59.44741", longitude:"24.69268" },
    { parcelShopType:"PickupStation", zipCode:"11415", city:"TALLINN", companyShortName:"Automaat Tallinna Ülemiste keskus", street:"Suur-Sõjamäe 4", countryCode:"EE", latitude:"59.42289", longitude:"24.7947" },
    { parcelShopType:"PickupStation", zipCode:"10132", city:"TALLINN", companyShortName:"Automaat Tallinna Arteri kvartal", street:"Liivalaia tn 36", countryCode:"EE", latitude:"59.4296", longitude:"24.759891" },
    { parcelShopType:"PickupStation", zipCode:"12911", city:"TALLINN", companyShortName:"Automaat Tallinna Vilde Maxima XX", street:"E. Vilde tee 75/77", countryCode:"EE", latitude:"59.402729", longitude:"24.685826" },
    { parcelShopType:"PickupStation", zipCode:"10617", city:"TALLINN", companyShortName:"Automaat Tallinna Marienthal Selver", street:"Mustamäe tee 16", countryCode:"EE", latitude:"59.422623", longitude:"24.696965" },
    { parcelShopType:"PickupStation", zipCode:"51010", city:"TARTU", companyShortName:"Automaat Tartu Riiamäe Alexela", street:"Era 2", countryCode:"EE", latitude:"58.371813", longitude:"26.721543" },
    { parcelShopType:"PickupStation", zipCode:"50106", city:"TARTU", companyShortName:"Automaat Sõbra Prisma", street:"Sõbra 58", countryCode:"EE", latitude:"58.36529052", longitude:"26.74327433" },
    { parcelShopType:"PickupStation", zipCode:"50709", city:"TARTU", companyShortName:"Automaat Tartu Mõisavahe Konsum", street:"Mõisavahe 34c", countryCode:"EE", latitude:"58.371894", longitude:"26.779842" },
    { parcelShopType:"PickupStation", zipCode:"80027", city:"PÄRNU", companyShortName:"Automaat Pärnu Raeküla Olevi Meie", street:"Olevi 27", countryCode:"EE", latitude:"58.35396", longitude:"24.56894" }
  ];

  // Väike käsitsi kogutud valim päris Smartpost my.smartpost.ee/api/places/ kirjetest (27.09.2026 seisuga).
  var SMARTPOST_SAMPLE_DATA = [
    { name:"Tallinna Arsenali Keskus", address_street:"Erika 14", address_city:"Tallinn", address_country_code:"ee", availability_info:"E-P8:00-22:00", location_info:"Sissepääsu juures vasakul", address_latitude:59.45153, address_longitude:24.71749 },
    { name:"Tallinna Ülemiste keskus", address_street:"Suur-Sõjamäe 4", address_city:"Tallinn", address_country_code:"ee", availability_info:"E-P9:00-21:00", location_info:"", address_latitude:59.42289, address_longitude:24.7947 },
    { name:"Tartu Eeden", address_street:"Turu 25", address_city:"Tartu", address_country_code:"ee", availability_info:"E-P8:00-22:00", location_info:"", address_latitude:58.373434, address_longitude:26.748826 },
    { name:"Pärnu Port Artur", address_street:"Riia mnt 128", address_city:"Pärnu", address_country_code:"ee", availability_info:"E-L9:00-21:00,P10:00-18:00", location_info:"", address_latitude:58.3859, address_longitude:24.4971 }
  ];

  // Väike käsitsi kogutud valim päris Venipak go.venipak.lt/ws/get_pickup_points kirjetest (27.09.2026 seisuga).
  var VENIPAK_SAMPLE_DATA = [
    { display_name:"Tallinna Kristiine keskus", address:"Endla 45", city:"Tallinn", country:"EE", lat:"59.4278", lng:"24.7263", working_hours:"", description:"Sissepääsu juures" },
    { display_name:"Tartu Lõunakeskus", address:"Ringtee 75", city:"Tartu", country:"EE", lat:"58.3559", lng:"26.6839", working_hours:"", description:"" },
    { display_name:"Pärnu Port Artur 2", address:"Riia mnt 128a", city:"Pärnu", country:"EE", lat:"58.3843", lng:"24.4986", working_hours:"", description:"" }
  ];

  // Väike käsitsi kogutud valim päris Unisend api-esavitarna.post.lt/terminal/list/csv kirjetest (27.09.2026 seisuga).
  var UNISEND_SAMPLE_DATA = [
    { name:"Pirita Selver", city:"Tallinn", address:"Rummu tee 4", postalCode:"11911", countryCode:"EE", latitude:"59.46235763", longitude:"24.82771488" },
    { name:"Sõbra Selver", city:"Tartu", address:"Sõbra tn 41", postalCode:"50106", countryCode:"EE", latitude:"58.36408206", longitude:"26.74107996" },
    { name:"Peetri Selver", city:"Peetri", address:"Veesaare tee 2", postalCode:"75312", countryCode:"EE", latitude:"59.402631293", longitude:"24.810446543" }
  ];

  // Kui Maa-ameti geokodeerimise API ka CORS-i tõttu ei vasta, kasuta neid varukoordinaate,
  // et otsingu- ja kaugusloogikat saaks siiski demost näha.
  var GEOCODE_FALLBACK = [
    { match:"narva mnt 5", lat:59.437957, lon:24.758514, label:"Narva mnt 5, Tallinn (näidiskoordinaat)" },
    { match:"riia 2", lat:58.372, lon:26.722, label:"Riia 2, Tartu (näidiskoordinaat)" },
    { match:"pärnu mnt 10", lat:58.3859, lon:24.4971, label:"Pärnu mnt 10, Pärnu (näidiskoordinaat)" }
  ];

  // ---------- map setup ----------
  var map = L.map("map", { scrollWheelZoom: true, doubleClickZoom: false }).setView([58.8, 25.3], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  var markersLayer = L.layerGroup().addTo(map);

  // Kui akna suurus muutub (nt telefoni pöörad, või kaardi kõrgus muutub
  // paigutuse murdepunktis), tuleb Leaflet'ile öelda, et ta oma mõõtmed
  // üle kontrolliks, muidu jäävad kaardikillud valesse kohta.
  var resizeTimer = null;
  function scheduleMapResize(){
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){ map.invalidateSize(); }, 150);
  }
  window.addEventListener("resize", scheduleMapResize);
  window.addEventListener("orientationchange", scheduleMapResize);

  function pinIcon(kind, label){
    return L.divIcon({
      className: "",
      html: '<div class="pin ' + kind + '"><span>' + label + "</span></div>",
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -24]
    });
  }

  // ---------- helpers ----------
  function haversineKm(lat1, lon1, lat2, lon2){
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
            Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function fmtKm(km){
    if (km < 1) return Math.round(km * 1000) + " m";
    return km.toFixed(1).replace(".", ",") + " km";
  }

  function setChip(el, kind, text){
    el.className = "chip " + kind;
    el.innerHTML = '<span class="dot"></span>' + text;
  }

  // ---------- data loading (päris andmed läbi Cloudflare Worker proxy) ----------
  function splitWorkerLockers(items){
    var omniva = [], dpd = [], smartpost = [], venipak = [], unisend = [];
    for (var i = 0; i < items.length; i++){
      var r = items[i];
      var lat = parseFloat(r.lat), lon = parseFloat(r.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (r.source === "omniva"){
        omniva.push({
          source: "omniva",
          name: r.name || "Omniva asukoht",
          addr: [r.city, r.county].filter(Boolean).join(", "),
          zip: r.zip || "",
          hours: r.hours || "",
          locationInfo: r.locationInfo || "",
          lat: lat, lon: lon
        });
      } else if (r.source === "dpd"){
        dpd.push({
          source: "dpd",
          name: r.name || "DPD asukoht",
          addr: [r.street, r.city].filter(Boolean).join(", "),
          zip: r.zip || "",
          hours: r.hours || "",
          locationInfo: r.locationInfo || "",
          lat: lat, lon: lon
        });
      } else if (r.source === "smartpost"){
        smartpost.push({
          source: "smartpost",
          name: r.name || "Smartpost asukoht",
          addr: [r.street, r.city].filter(Boolean).join(", "),
          zip: r.zip || "",
          hours: r.hours || "",
          locationInfo: r.locationInfo || "",
          lat: lat, lon: lon
        });
      } else if (r.source === "venipak"){
        venipak.push({
          source: "venipak",
          name: r.name || "Venipak asukoht",
          addr: [r.street, r.city].filter(Boolean).join(", "),
          zip: r.zip || "",
          hours: r.hours || "",
          locationInfo: r.locationInfo || "",
          lat: lat, lon: lon
        });
      } else if (r.source === "unisend"){
        unisend.push({
          source: "unisend",
          name: r.name || "Unisend asukoht",
          addr: [r.street, r.city].filter(Boolean).join(", "),
          zip: r.zip || "",
          hours: r.hours || "",
          locationInfo: r.locationInfo || "",
          lat: lat, lon: lon
        });
      }
    }
    return { omniva: omniva, dpd: dpd, smartpost: smartpost, venipak: venipak, unisend: unisend };
  }

  function loadLockers(){
    fetch(WORKER_URL)
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(data){
        var split = splitWorkerLockers(data.lockers || []);
        var errors = data.errors || {};
        var stale = data.stale || {};

        function applySource(key, sampleFn, chipId, label){
          var list = split[key];
          if (list.length) {
            state[key] = list;
            if (stale[key]) {
              setChip(document.getElementById(chipId), "bad", label + " pakiautomaadid: <b>" + list.length + "</b> (viimased teadaolevad, allikas hetkel ei vasta)");
            } else {
              setChip(document.getElementById(chipId), "ok", label + " pakiautomaadid: <b>" + list.length + "</b>");
            }
          } else {
            sampleFn(errors[key] || "worker tagastas 0 kirjet");
          }
        }

        applySource("omniva", useSampleOmniva, "chipOmniva", "Omniva");
        applySource("dpd", useSampleDpd, "chipDpd", "DPD");
        applySource("smartpost", useSampleSmartpost, "chipSmartpost", "Smartpost");
        applySource("venipak", useSampleVenipak, "chipVenipak", "Venipak");
        applySource("unisend", useSampleUnisend, "chipUnisend", "Unisend");
      })
      .catch(function(err){
        useSampleOmniva(err.message);
        useSampleDpd(err.message);
        useSampleSmartpost(err.message);
        useSampleVenipak(err.message);
        useSampleUnisend(err.message);
      });
  }

  function useSampleOmniva(reason){
    state.omniva = normalizeOmniva(OMNIVA_SAMPLE_DATA);
    setChip(document.getElementById("chipOmniva"), "bad", "Omniva: näidisandmed (" + escapeHtml(reason) + ")");
  }

  function useSampleDpd(reason){
    state.dpd = normalizeDpd(DPD_SAMPLE_DATA);
    setChip(document.getElementById("chipDpd"), "bad", "DPD: näidisandmed (" + escapeHtml(reason) + ")");
  }

  function useSampleSmartpost(reason){
    state.smartpost = normalizeSmartpost(SMARTPOST_SAMPLE_DATA);
    setChip(document.getElementById("chipSmartpost"), "bad", "Smartpost: näidisandmed (" + escapeHtml(reason) + ")");
  }

  function useSampleVenipak(reason){
    state.venipak = normalizeVenipak(VENIPAK_SAMPLE_DATA);
    setChip(document.getElementById("chipVenipak"), "bad", "Venipak: näidisandmed (" + escapeHtml(reason) + ")");
  }

  function useSampleUnisend(reason){
    state.unisend = normalizeUnisend(UNISEND_SAMPLE_DATA);
    setChip(document.getElementById("chipUnisend"), "bad", "Unisend: näidisandmed (" + escapeHtml(reason) + ")");
  }

  function normalizeOmniva(raw){
    var list = Array.isArray(raw) ? raw : (raw && raw.data) || [];
    var out = [];
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      var lat = parseFloat(r.Y_COORDINATE || r.y_coordinate);
      var lon = parseFloat(r.X_COORDINATE || r.x_coordinate);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      out.push({
        source: "omniva",
        name: r.NAME || r.name || "Omniva asukoht",
        addr: [r.A2_NAME, r.A1_NAME].filter(Boolean).join(", "),
        zip: r.ZIP || r.zip || "",
        lat: lat, lon: lon
      });
    }
    return out;
  }

  function normalizeDpd(raw){
    var list = Array.isArray(raw) ? raw : (raw && raw.data) || [];
    var out = [];
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      if (r.countryCode && r.countryCode !== "EE") continue;
      var lat = parseFloat(r.latitude);
      var lon = parseFloat(r.longitude);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var streetBits = [r.street, r.houseNo].filter(Boolean).join(" ");
      out.push({
        source: "dpd",
        name: r.companyShortName || r.companyName || "DPD asukoht",
        addr: [streetBits, r.city].filter(Boolean).join(", "),
        zip: r.zipCode || "",
        lat: lat, lon: lon
      });
    }
    return out;
  }

  function normalizeSmartpost(raw){
    var list = Array.isArray(raw) ? raw : (raw && raw.data) || [];
    var out = [];
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      if (r.address_country_code && r.address_country_code.toLowerCase() !== "ee") continue;
      var lat = parseFloat(r.address_latitude);
      var lon = parseFloat(r.address_longitude);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      out.push({
        source: "smartpost",
        name: r.name || "Smartpost asukoht",
        addr: [r.address_street, r.address_city].filter(Boolean).join(", "),
        zip: r.address_zip || "",
        hours: r.availability_info || "",
        locationInfo: r.location_info || "",
        lat: lat, lon: lon
      });
    }
    return out;
  }

  function normalizeVenipak(raw){
    var list = Array.isArray(raw) ? raw : (raw && raw.data) || [];
    var out = [];
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      if (r.country && r.country !== "EE") continue;
      var lat = parseFloat(r.lat);
      var lon = parseFloat(r.lng);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      out.push({
        source: "venipak",
        name: r.display_name || r.name || "Venipak asukoht",
        addr: [r.address, r.city].filter(Boolean).join(", "),
        zip: r.zip || "",
        hours: "",
        locationInfo: r.description || "",
        lat: lat, lon: lon
      });
    }
    return out;
  }

  function normalizeUnisend(raw){
    var list = Array.isArray(raw) ? raw : (raw && raw.data) || [];
    var out = [];
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      if (r.countryCode && r.countryCode !== "EE") continue;
      var lat = parseFloat(r.latitude);
      var lon = parseFloat(r.longitude);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      out.push({
        source: "unisend",
        name: r.name || "Unisend asukoht",
        addr: [r.address, r.city].filter(Boolean).join(", "),
        zip: r.postalCode || "",
        hours: "",
        locationInfo: r.comment || "",
        lat: lat, lon: lon
      });
    }
    return out;
  }

  // ---------- geocoding ----------
  function findFallback(text){
    var needle = text.toLowerCase();
    for (var i = 0; i < GEOCODE_FALLBACK.length; i++){
      if (needle.indexOf(GEOCODE_FALLBACK[i].match) !== -1) return GEOCODE_FALLBACK[i];
    }
    return null;
  }

  // Tagastab KÕIK Maa-ameti kandidaataadressid (mitte ainult esimese), et
  // mitmetähendusliku otsingu (nt "Narva mnt 5" ilma linnata) korral saaks
  // kasutajale valiku pakkuda selle asemel, et suvaliselt üks neist valida.
  function geocodeCandidates(text){
    var url = WORKER_GEOCODE_URL + "?text=" + encodeURIComponent(text);
    return fetch(url).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(payload){
      if (payload.error) throw new Error(payload.error);
      var data = payload.result;
      var list = Array.isArray(data) ? data : (data && data.addresses ? data.addresses : (data ? [data] : []));
      var out = list.map(function(hit){
        if (!hit || typeof hit.b === "undefined" || typeof hit.l === "undefined") return null;
        return { lat: parseFloat(hit.l), lon: parseFloat(hit.b), label: hit.normaddress || text };
      }).filter(Boolean);
      if (!out.length) throw new Error("Aadressi ei leitud");
      return out;
    }).catch(function(err){
      var fb = findFallback(text);
      if (fb) return [{ lat: fb.lat, lon: fb.lon, label: fb.label }];
      throw err;
    });
  }

  function hideAddrDropdown(){
    var dd = document.getElementById("addrDropdown");
    dd.hidden = true;
    dd.innerHTML = "";
  }

  function showAddrDropdown(candidates){
    var dd = document.getElementById("addrDropdown");
    dd.innerHTML = "";
    candidates.slice(0, 8).forEach(function(c){
      var item = document.createElement("div");
      item.className = "addr-item";
      item.tabIndex = 0;
      item.textContent = c.label;
      item.addEventListener("click", function(){ pickAddrCandidate(c); });
      item.addEventListener("keydown", function(e){
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickAddrCandidate(c); }
      });
      dd.appendChild(item);
    });
    dd.hidden = false;
  }

  function pickAddrCandidate(c){
    hideAddrDropdown();
    state.userPoint = { lat: c.lat, lon: c.lon, label: c.label };
    var hint = document.getElementById("searchHint");
    hint.className = "hint ok";
    hint.textContent = "Leitud: " + c.label;
    renderResults(state.userPoint);
  }

  // ---------- automaadi nime järgi otsimine ----------
  function allLockers(){
    return [].concat(state.omniva || [], state.dpd || [], state.smartpost || [], state.venipak || [], state.unisend || []);
  }

  function filteredLockers(){
    var all = allLockers();
    if (!state.carrierFilter) return all;
    return all.filter(function(item){ return item.source === state.carrierFilter; });
  }

  var CARRIER_LABELS = { omniva: "Omniva", dpd: "DPD", smartpost: "Smartpost", venipak: "Venipak", unisend: "Unisend" };

  // Otsime AINULT automaadi enda nime järgi (nt "Põlva Selver"), mitte enam
  // ka aadressiteksti seest. Kui vaataksime ka item.addr, siis nt "Narva
  // mnt 5" tabaks kohe ära suvalise automaadi, mille aadress juhtub seda
  // teksti sisaldama (nt Tallinnas), ilma et kasutaja seda üldse otsis —
  // ja varjaks täielikult meie Maa-ameti geokodeerimise (koos selle
  // "vali õige linn" vihje/valikuga), kuna see kood ei jõuaks kunagi käivituda.
  // Aadressiotsingud peavad alati minema geokodeerimise kaudu.
  function findLockerMatches(text, ignoreCarrierFilter){
    var needle = text.trim().toLowerCase();
    if (needle.length < 2) return [];
    var words = needle.split(/\s+/);
    var pool = ignoreCarrierFilter ? allLockers() : filteredLockers();
    return pool.filter(function(item){
      var hay = item.name.toLowerCase();
      return words.every(function(w){ return hay.indexOf(w) !== -1; });
    }).slice(0, 8);
  }

  // ---------- reaalajas vihjed (tippimise ajal) ----------
  // Erinevalt findLockerMatches'ist (mida kasutab "Otsi" nupp/Enter ja mis
  // otsib TÄPSUSE huvides ainult nime järgi), otsib see ka aadressi/linna
  // seest — kuna kasutaja klõpsab siin nimekirjast TEADLIKULT ühe valiku,
  // pole enam ohtu, et "Narva mnt 5"-taoline tekst kellegi eest ära arvatakse.
  // Nii saab nt "põlv" kirjutades kohe näha kõiki Põlvas asuvaid automaate,
  // isegi kui linnanimi pole automaadi enda nimeväljas.
  function findLiveSuggestions(text){
    var needle = text.trim().toLowerCase();
    if (needle.length < 2) return [];
    var words = needle.split(/\s+/);
    var pool = filteredLockers();
    var nameHits = [], addrHits = [];
    pool.forEach(function(item){
      var nameHay = item.name.toLowerCase();
      if (words.every(function(w){ return nameHay.indexOf(w) !== -1; })) {
        nameHits.push(item);
        return;
      }
      var fullHay = nameHay + " " + (item.addr || "").toLowerCase();
      if (words.every(function(w){ return fullHay.indexOf(w) !== -1; })) {
        addrHits.push(item);
      }
    });
    return nameHits.concat(addrHits).slice(0, 8);
  }

  function showLockerSuggestions(items){
    var dd = document.getElementById("addrDropdown");
    dd.innerHTML = "";
    items.forEach(function(item){
      var el = document.createElement("div");
      el.className = "addr-item";
      el.tabIndex = 0;
      el.innerHTML = '<span class="badge ' + item.source + '">' + item.source + "</span> " +
        "<strong>" + escapeHtml(item.name) + "</strong>" +
        (item.addr ? ' <span class="muted-inline">— ' + escapeHtml(item.addr) + "</span>" : "");
      // mousedown + preventDefault (mitte "click"): nii ei jõua sisendväli
      // enne valikut fookust kaotada ja meie oma peida-dropdown blur-loogika
      // ei jõua elementi enne klõpsu käsitlemist DOM-ist eemaldada.
      el.addEventListener("mousedown", function(e){ e.preventDefault(); pickLockerSuggestion(item); });
      el.addEventListener("keydown", function(e){
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickLockerSuggestion(item); }
      });
      dd.appendChild(el);
    });
    dd.hidden = false;
  }

  function pickLockerSuggestion(item){
    hideAddrDropdown();
    document.getElementById("addressInput").value = item.name;
    updateClearBtn();
    state.exactMatches = [item];
    var hint = document.getElementById("searchHint");
    hint.className = "hint ok";
    hint.textContent = "Valitud automaat: " + item.name;
    useLockerAsOrigin(item, item.name);
  }

  function matchKey(item){
    return item.source + "|" + item.lat + "|" + item.lon + "|" + item.name;
  }

  // Praeguse otsingu täpsed nimevasted (nt "Põlva Selver" juures olevad
  // Omniva + DPD punktid), vedaja filtriga arvestatuna.
  function currentExactMatches(){
    return (state.exactMatches || []).filter(function(item){
      return !state.carrierFilter || item.source === state.carrierFilter;
    });
  }

  function useLockerAsOrigin(m, label){
    var pt = { lat: m.lat, lon: m.lon, label: label || (m.name + (m.addr ? ", " + m.addr : "")) };
    state.userPoint = pt;
    renderResults(pt);
  }

  // ---------- search + render ----------
  function runSearch(text){
    var hint = document.getElementById("searchHint");
    var btn = document.getElementById("searchBtn");
    btn.disabled = true;
    hideAddrDropdown();

    var nameMatches = findLockerMatches(text);
    if (nameMatches.length >= 1) {
      var best = nameMatches[0];
      state.exactMatches = nameMatches;
      hint.className = "hint ok";
      hint.textContent = nameMatches.length === 1
        ? "Leitud automaat: " + best.name
        : "Leitud " + nameMatches.length + " automaati “" + text + "” juures.";
      useLockerAsOrigin(best, text);
      btn.disabled = false;
      return;
    }

    // Kui valitud on vedaja filter ja nimeotsing filtreeritud hulgast
    // vastet ei leidnud, kontrollime, kas mõni teine vedaja siiski sellise
    // nimega automaadi juures asub — sel juhul pole tegu veaga, vaid lihtsalt
    // filtriga peidetud tulemusega.
    if (state.carrierFilter) {
      var hiddenMatches = findLockerMatches(text, true);
      if (hiddenMatches.length >= 1) {
        var hidden = hiddenMatches[0];
        state.exactMatches = [];
        hint.className = "hint";
        hint.textContent = "Valitud vedajal (" + (CARRIER_LABELS[state.carrierFilter] || state.carrierFilter) +
          ") ei ole selles asukohas automaati. Vali vedajaks “Kõik”, et see näha saada — praegu näitan lähimaid " +
          (CARRIER_LABELS[state.carrierFilter] || state.carrierFilter) + " automaate selle koha ümber.";
        useLockerAsOrigin(hidden, text);
        btn.disabled = false;
        return;
      }
    }

    state.exactMatches = [];
    hint.className = "hint";
    hint.textContent = "Automaadi nime järgi vastet ei leitud, proovin aadressina…";

    geocodeCandidates(text).then(function(candidates){
      if (candidates.length > 1) {
        hint.className = "hint";
        hint.textContent = "Leiti " + candidates.length + " sarnast aadressi — vali õige allolevast loendist.";
        showAddrDropdown(candidates);
        return;
      }
      var pt = candidates[0];
      state.userPoint = pt;
      hint.className = "hint ok";
      // Maa-amet valib ise "parima" aadressi ega paku kunagi teiste
      // linnade samanimelisi tänavaid valikuks (kontrollitud). Kui otsing
      // ei sisaldanud koma (st tõenäoliselt polnud linna/valda kaasas),
      // aga leitud aadress seda sisaldab, vihjame kasutajale, et vajadusel
      // saab otsingut linnanimega täpsustada.
      var extra = (text.indexOf(",") === -1 && pt.label.indexOf(",") !== -1)
        ? " — kui see pole õige koht, täpsusta linna/valla nimega (nt “" + text + ", Tartu”)."
        : "";
      hint.textContent = "Leitud: " + pt.label + extra;
      renderResults(pt);
    }).catch(function(err){
      hint.className = "hint error";
      hint.textContent = "Ei leidnud sellenimelist automaati ega õnnestunud aadressina geokodeerida (" + err.message + ").";
    }).finally(function(){
      btn.disabled = false;
    });
  }

  function popupHtml(item, extraLine){
    return '<div class="popup-title">' + escapeHtml(item.name) + "</div>" +
      '<div class="popup-addr">' + escapeHtml(item.addr || "") + "</div>" +
      (item.hours ? '<div class="popup-addr">&#9200; ' + escapeHtml(item.hours) + "</div>" : "") +
      (item.locationInfo ? '<div class="popup-addr">&#128205; ' + escapeHtml(item.locationInfo) + "</div>" : "") +
      '<div class="popup-dist">' + extraLine + "</div>";
  }

  function buildRow(item, opts){
    opts = opts || {};
    var row = document.createElement("div");
    row.className = "result-item";
    row.innerHTML =
      (opts.rank ? '<div class="rank">' + opts.rank + "</div>" : "") +
      '<div class="result-body">' +
        '<div class="result-top">' +
          '<span class="badge ' + item.source + '">' + item.source + "</span>" +
          '<span class="result-name">' + escapeHtml(item.name) + "</span>" +
        "</div>" +
        '<div class="result-addr">' + escapeHtml(item.addr || "") + (item.zip ? ", " + item.zip : "") + "</div>" +
        (item.hours ? '<div class="result-hours">&#9200; ' + escapeHtml(item.hours) + "</div>" : "") +
        (item.locationInfo ? '<div class="result-loc">&#128205; ' + escapeHtml(item.locationInfo) + "</div>" : "") +
        (typeof item.dist === "number" ? '<div class="result-dist"><span class="mono">' + fmtKm(item.dist) + "</span> eemal</div>" : "") +
      "</div>";
    return row;
  }

  function renderResults(pt){
    var exactList = currentExactMatches();
    var exactKeys = exactList.map(matchKey);

    var all = filteredLockers();
    var withDist = all.map(function(p){
      return Object.assign({}, p, { dist: haversineKm(pt.lat, pt.lon, p.lat, p.lon) });
    });
    withDist.sort(function(a,b){ return a.dist - b.dist; });

    // Täpsed vasted näidatakse eraldi plokis, seega jäetakse need "läheduses" nimekirjast välja.
    var nearby = withDist.filter(function(item){
      return exactKeys.indexOf(matchKey(item)) === -1;
    }).slice(0, 10);

    var exactSection = document.getElementById("exactSection");
    var exactEl = document.getElementById("exactResults");
    var resultsEl = document.getElementById("results");
    var nearbyTitle = document.getElementById("nearbyTitle");
    exactEl.innerHTML = "";
    resultsEl.innerHTML = "";
    nearbyTitle.textContent = exactList.length ? "Läheduses" : "Lähimad automaadid";

    markersLayer.clearLayers();

    var userMarker = L.marker([pt.lat, pt.lon], { icon: pinIcon("user", "★") })
      .addTo(markersLayer)
      .bindPopup('<div class="popup-title">Sinu asukoht</div><div class="popup-addr">' + pt.label + "</div>");

    var bounds = [[pt.lat, pt.lon]];

    if (exactList.length) {
      exactSection.hidden = false;
      document.querySelector("#exactSection .section-title").textContent = "Selles asukohas (" + exactList.length + ")";
      exactList.forEach(function(item){
        var dist = haversineKm(pt.lat, pt.lon, item.lat, item.lon);
        var icon = pinIcon(item.source, "•");
        var m = L.marker([item.lat, item.lon], { icon: icon }).addTo(markersLayer);
        m.bindPopup(popupHtml(item, item.source.toUpperCase()));
        bounds.push([item.lat, item.lon]);

        var row = buildRow(item, {});
        row.addEventListener("click", function(){
          map.setView([item.lat, item.lon], 16);
          m.openPopup();
        });
        exactEl.appendChild(row);
      });
    } else {
      exactSection.hidden = true;
    }

    if (!all.length) {
      resultsEl.innerHTML = '<div class="empty">Ühtegi allikat ei õnnestunud laadida, seega pole midagi võrrelda. Vaata ülalt, kumb API blokeeriti.</div>';
    } else if (!nearby.length) {
      resultsEl.innerHTML = '<div class="empty">Teisi automaate läheduses ei leitud.</div>';
    }

    nearby.forEach(function(item, idx){
      var icon = pinIcon(item.source, String(idx + 1));
      var m = L.marker([item.lat, item.lon], { icon: icon }).addTo(markersLayer);
      m.bindPopup(popupHtml(item, fmtKm(item.dist) + " eemal &middot; " + item.source.toUpperCase()));
      bounds.push([item.lat, item.lon]);

      var row = buildRow(item, { rank: idx + 1 });
      row.addEventListener("click", function(){
        document.querySelectorAll(".result-item").forEach(function(el){ el.classList.remove("active"); });
        row.classList.add("active");
        map.setView([item.lat, item.lon], 15);
        m.openPopup();
      });
      resultsEl.appendChild(row);
    });

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
    } else {
      map.setView([pt.lat, pt.lon], 13);
    }
    userMarker.openPopup();
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }

  // ---------- wiring ----------
  document.getElementById("searchForm").addEventListener("submit", function(e){
    e.preventDefault();
    var val = document.getElementById("addressInput").value.trim();
    if (val) runSearch(val);
  });

  // Tippimise ajal näidatav automaatide/asukohtade vihjeloend (autocomplete).
  var suggestTimer = null;
  var addressInputEl = document.getElementById("addressInput");
  var clearInputBtn = document.getElementById("clearInputBtn");

  // Otsinguväli EI tühjene enam iseenesest fookuse saamisel (see tegi
  // olemasoleva otsingu täpsustamise ebamugavaks) — selle asemel on väljal
  // endal selge "X" tühjendusnupp, mis ilmub ainult siis, kui väljal on teksti.
  function updateClearBtn(){
    clearInputBtn.hidden = !addressInputEl.value;
  }
  clearInputBtn.addEventListener("click", function(){
    addressInputEl.value = "";
    updateClearBtn();
    hideAddrDropdown();
    addressInputEl.focus();
  });
  addressInputEl.addEventListener("input", function(){
    var text = addressInputEl.value;
    updateClearBtn();
    if (suggestTimer) clearTimeout(suggestTimer);
    if (text.trim().length < 2) { hideAddrDropdown(); return; }
    suggestTimer = setTimeout(function(){
      var hits = findLiveSuggestions(text);
      if (hits.length) showLockerSuggestions(hits); else hideAddrDropdown();
    }, 150);
  });
  addressInputEl.addEventListener("keydown", function(e){
    if (e.key === "Escape") hideAddrDropdown();
  });
  addressInputEl.addEventListener("blur", function(){
    // Väike viide, et mousedown-põhine valik (vt showLockerSuggestions)
    // jõuaks kohale enne, kui dropdown peidetakse.
    setTimeout(hideAddrDropdown, 150);
  });

  document.querySelectorAll("#carrierFilter button[data-source]").forEach(function(btn){
    btn.addEventListener("click", function(){
      document.querySelectorAll("#carrierFilter button[data-source]").forEach(function(b){ b.classList.remove("active"); });
      btn.classList.add("active");
      state.carrierFilter = btn.getAttribute("data-source") || null;
      if (state.userPoint) renderResults(state.userPoint);
    });
  });

  // Kaardil topeltklõpsates kasutatakse klõpsatud kohta lähtepunktina — sama
  // moodi nagu aadressi otsides, ainult ilma tippimata. Topeltklõps (mitte
  // tavaline klõps), et see ei seguneks kaardil liikumisega ning kaardi
  // tavapärane "topeltklõps suumib" käitumine on eespool välja lülitatud.
  map.on("dblclick", function(e){
    document.getElementById("addressInput").value = "";
    updateClearBtn();
    state.exactMatches = [];
    hideAddrDropdown();
    var pt = {
      lat: e.latlng.lat,
      lon: e.latlng.lng,
      label: "Valitud koht kaardil (" + e.latlng.lat.toFixed(5) + ", " + e.latlng.lng.toFixed(5) + ")"
    };
    state.userPoint = pt;
    var hint = document.getElementById("searchHint");
    hint.className = "hint ok";
    hint.textContent = "Lähtepunkt: " + pt.label;
    renderResults(pt);
  });

  // Teema (hele/tume) valik: vaikimisi käib seadme/brauseri eelistuse
  // järgi (CSS prefers-color-scheme), aga nupuga saab valida käsitsi ja
  // valik jääb localStorage'i meelde.
  (function(){
    var THEME_KEY = "theme-preference";
    var root = document.documentElement;
    var btn = document.getElementById("themeToggle");
    function savedTheme(){
      try { return localStorage.getItem(THEME_KEY); } catch(e){ return null; }
    }
    function systemTheme(){
      return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    }
    function effectiveTheme(){
      var saved = savedTheme();
      return (saved === "light" || saved === "dark") ? saved : systemTheme();
    }
    function updateBtn(){
      if (!btn) return;
      var eff = effectiveTheme();
      btn.innerHTML = eff === "dark" ? "&#9728;" : "&#9789;";
      var label = eff === "dark" ? "Lülitu heledale teemale" : "Lülitu tumedale teemale";
      btn.setAttribute("aria-label", label);
      btn.title = label;
    }
    updateBtn();
    if (btn){
      btn.addEventListener("click", function(){
        var next = effectiveTheme() === "dark" ? "light" : "dark";
        try { localStorage.setItem(THEME_KEY, next); } catch(e){}
        root.setAttribute("data-theme", next);
        updateBtn();
      });
    }
    if (window.matchMedia){
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function(){
        if (!savedTheme()) updateBtn();
      });
    }
  })();

  loadLockers();
})();
