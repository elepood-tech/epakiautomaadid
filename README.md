# Pakiautomaadid

Veebileht, mis leiab aadressi või pakiautomaadi nime järgi lähimad Omniva ja DPD pakiautomaadid Eestis.

## Struktuur

- `index.html` — frontend (kaart, otsing, tulemuste nimekiri). Deploy'takse **Cloudflare Pages'i**.
- `worker.js` — Cloudflare Worker, mis proxib Omniva/DPD/Maa-ameti andmed (CORS-i pärast) ja puhverdab need. Deploy'takse **Cloudflare Workersisse**.

## Andmeallikad

- Omniva: `https://www.omniva.ee/locations.json` (avalik, autentimist ei vaja)
- DPD: `https://dpdbaltics.com/PickupParcelShopData.json` (avalik, autentimist ei vaja)
- Maa-amet geokodeerimine: `https://inaadress.maaamet.ee/geocoder-api/api/online` (avalik API)

Worker teeb päringud serveripoolelt, kuna need serverid ei saada brauserile CORS-päiseid.

## Deploy

1. **Cloudflare Pages**: ühenda see GitHub repo Cloudflare Pages projektiga, build command tühi, väljundikaust juurikas (`/`) — deploy'b `index.html` automaatselt iga push'i peale.
2. **Cloudflare Workers**: ühenda `worker.js` Cloudflare Workers Builds'i (Git integratsioon) sama repo peale, et see automaatselt uuenda.

## Unisend (ametlik API)

Unisendi terminalid tulevad ametlikust API-st (`/api/v2/terminal`). Sisselogimisandmed on Cloudflare Workeri secretid, mitte repos:

```
wrangler secret put UNISEND_USER
wrangler secret put UNISEND_PASS
```

Ilma secretiteta jääb Unisend välja lülitatuks. Unisendi päringud kasutavad mitte-brauseri User-Agent'i (nende tulemüür blokeerib brauseri oma).
