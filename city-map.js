// Linnalehe kaart: joonistab sama lehe sisse pandud (#city-data) asukohad Leafleti kaardile.
// Andmed on JSON-ina HTML-is, seega kaart ei vaja eraldi päringuid vedajate poole.
(function(){
  "use strict";
  var el = document.getElementById("city-data");
  var mapEl = document.getElementById("map");
  if (!el || !mapEl || !window.L) return;

  var items;
  try { items = JSON.parse(el.textContent); } catch (e) { return; }
  if (!items.length) return;

  var labels = { omniva: "Omniva", dpd: "DPD", smartpost: "Smartpost", venipak: "Venipak", unisend: "Unisend" };
  var map = L.map(mapEl, { scrollWheelZoom: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  var css = getComputedStyle(document.documentElement);
  var points = [];
  items.forEach(function(it){
    var color = css.getPropertyValue("--" + it.s).trim() || "#555";
    var marker = L.circleMarker([it.a, it.o], {
      radius: 7, color: "#ffffff", weight: 1.5, fillColor: color, fillOpacity: 0.95
    }).addTo(map);

    // Popup ehitatakse DOM-i kaudu (textContent), mitte HTML-stringina.
    var box = document.createElement("div");
    var title = document.createElement("strong");
    title.textContent = it.n;
    box.appendChild(title);
    var line = document.createElement("div");
    line.textContent = (labels[it.s] || it.s) + (it.d ? " — " + it.d : "");
    box.appendChild(line);
    marker.bindPopup(box);
    points.push([it.a, it.o]);
  });

  map.fitBounds(points, { padding: [24, 24], maxZoom: 15 });
})();
