# Algo Levels — NQ confluence terminál (GEXbot)

Tři soubory:

| Soubor | Kam | Co dělá |
|---|---|---|
| `worker.js` | Cloudflare Worker | drží GEXbot klíč, řeší CORS, tahá GEXbot + Yahoo (NQ 1m, NQ denní, VIX), cache 15–20 s |
| `index.html` | `bartikozz.github.io/algo-levels/` | graf + seznam levelů, alerty |
| `levels.js` | vedle `index.html` | engine: kandidáti → confluence clustery → směr → status |

## 1. Worker (5 min)

1. dash.cloudflare.com → **Workers & Pages → Create → Worker** → název `algo-levels` → Deploy.
2. **Edit code** → smaž obsah, vlož `worker.js` → Deploy.
3. **Settings → Variables and Secrets** → přidej jako *Secret*:
   - `GEXBOT_API_KEY` = celý klíč včetně prefixu `gexbot_custom_...`
   - `ACCESS_TOKEN` = libovolný náhodný řetězec (třeba 20 znaků)
4. Otestuj: `https://algo-levels.<tvuj-subdomain>.workers.dev/health` → `{"ok":true,"key":true,"token":true}`
5. Test dat: `.../gex/NQ_NDX/classic/gex_zero?t=<ACCESS_TOKEN>` → JSON se `strikes`.

## 2. Web

1. Do repa `bartikozz.github.io` nahraj složku `algo-levels/` s `index.html` + `levels.js`.
2. Otevři `https://bartikozz.github.io/algo-levels/` → ⚙ → URL Workeru + token → Uložit.
3. Na mobilu: Sdílet → Přidat na plochu. Alerty zapneš tlačítkem v ⚙ (zvuk potřebuje jedno klepnutí).

## Live cena

Terminál bere každých 5 s `spot` z `NQ_NDX/classic/gex_zero/majors` (Worker cache 4 s) a skládá z něj 1min svíčky.
Yahoo slouží jen jako historie (zpožděná ~10 min). Badge vedle stavu ukazuje zdroj:
- `LIVE Ns`: živá cena z GEXbotu, N = stáří dat
- `GEX stale · Yahoo`: GEXbot data starší než 2 min (mimo trh / výpadek)
- `Yahoo ~10 min`: GEXbot nedostupný

Hustota svíček = jak často GEXbot obnovuje spot. High/low svíčky jsou z 5s vzorků, takže knoty můžou být o pár bodů kratší než na grafu z burzy.

## TradingView

1. TradingView → Pine Editor → vlož `algo_levels_tv.pine` → Add to chart (NQ1!).
2. V terminálu klikni **⧉ TradingView** → v nastavení indikátoru vlož do „Levely z terminálu“.
3. Alert: Create alert → Condition: Algo Levels → **Any alert() function call**.
0DTE walls se přes den mění, takže levely do TV aktualizuj 1–2× za session (open, po 12:00). Terminál je aktuální průběžně.

## Jak se počítá level

Kandidáti (váha):
- **0DTE** (`NQ_NDX gex_zero`): CW 1–3 / PW 1–3 (3 / 2 / 1.5), ZG (2)
- **1DTE** (`gex_one`): CW/PW 1–2 (2 / 1)
- **Full chain** (`gex_full`): CW/PW 1–3 (2.5 / 1.5 / 1), ZG (2.5), OI CW / OI PW (2)
- **ΔGEX 15m** (`gex_zero/maxchange`): strike s největší změnou GEX za 15 min (1.5)
- **QQQ walls** (`QQQ gex_full`, OI, jen strike 0/5) převedené živým poměrem NQ/QQQ (2 / 1)
- **QQQ 0/5 levely** ±2 % od spotu (1)
- **VIX EM** ±½, ±1 z RTH openu (1.5)
- **σ Grid** ±½ (1), ±1 (1.5) z 20denní σ, anchor Globex open
- **Prev VP**: pPOC (1.5), pVAH / pVAL (1)

Kandidáti do `tol` bodů (default 10) se slijí do jednoho levelu. Cena levelu = nejsilnější člen (při shodě vyhrává options strike). Skóre = součet vah. Zobrazuje se skóre ≥ min.

**Směr**: level nad cenou = ▼ Short, pod cenou = ▲ Long. Badge **+γ / −γ** podle znaménka `sum_gex_vol` z 0DTE: v −γ ber fade jen s footprint potvrzením.

**Status** (z dnešních RTH barů):
- *Reacted HH:MM* — dotyk zóny (±touch), pak do `lookahead` barů pohyb ≥ `react` bodů od levelu bez close za levelem
- *Broken HH:MM* — close za levelem o víc než `break`
- *Testing* — cena je v zóně a ještě se nerozhodlo
- *×N* — kolikrát reagoval

## Omezení
- Yahoo NQ=F 1m je zpožděné (~10 min) a občas vrací chyby. Pro živé ceny je potřeba jiný feed (Tradovate, Databento). Engine jen dostane jiné bary.
- Pokud tvůj GEXbot tier nemá `gex_one` nebo `maxchange`, vypni ty vrstvy v ⚙. Ostatní poběží dál (meta řádek ukáže, co selhalo).
- IV wall / IV peak (jako u pendqnt) potřebují State nebo Research balíček, zatím tu nejsou.
