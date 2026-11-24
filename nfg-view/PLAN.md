# NFG Getafe – Friendly View: Investigation Notes & Plan

> Status: **draft for review**. Nothing has been built yet.
> Target: `https://getafe.ffmadrid.es/nfg/` (Novanet "NFG" intranet, Competición Local de Getafe – RFFM)
> Account used for investigation: club user for **LOS PACHONES (club code 9028)**. Credentials are **not** stored in this repo.

---

## 1. What we observed

### 1.1 Platform
- Vendor product: **Novanet NFG** (Java servlet app behind Apache, `JSESSIONID` cookie, ISO-8859-15 encoding).
- UI: Metronic/Bootstrap theme on top of a legacy jQuery 1.x / jQuery UI app. Lots of `document.write`, hidden iframes and `javascript:` links.
- **Everything is server-rendered HTML.** There is no JSON API. Dynamic dropdowns return small HTML pages containing `<script>` with JS arrays.
- **All data pages require login.** Without a session every URL returns the login page (HTTP 200, ~21 KB, `<title>Novanet | Login</title>`), so "not logged in" must be detected by content, not status code.

### 1.2 Login flow
| Step | Request | Notes |
|---|---|---|
| 1 | `GET /nfg/` | Sets `JSESSIONID` (Path=/nfg; Secure; HttpOnly; SameSite=Lax) |
| 2 | `POST /nfg/NLogin` body `NUser=…&NPass=…&LoginAjax=1&N_Ajax=1` | Returns a tiny `<script>` with `var estado="1"` on success (`"2"` or lower = bad credentials) |
| 3 | Any `GET /nfg/NPcd/<Procedure>?…` | Authenticated pages |
| – | `GET /nfg/NLogout?NURL=/nfg` | Logout |

**Important quirk:** the authenticated session only survived when all requests reused **the same TCP connection** (keep-alive). Separate `curl` calls got a fresh `JSESSIONID` and landed on the login page. Likely cause: sticky load balancing by client IP/connection (in our cloud sandbox the outbound IP may rotate). From a fixed IP it may work normally, but **the client must keep one persistent HTTP session** (e.g. Python `requests.Session`, Node `undici` agent with keep-alive) and be ready to re-login.

### 1.3 URL pattern
All screens are `/nfg/NPcd/<ProcedureName>?cod_primaria=<menuId>&…params`.
`cod_primaria` is the menu/permission id and seems mandatory.

### 1.4 Menu for this club user (read-only parts are marked ✅)
| Section | Procedure | `cod_primaria` | Useful for the view |
|---|---|---|---|
| Mi Club | `NFG_VerMiClub` | 1000110 | ✅ club info, kit colours, teams |
| Licencias – Buscador | `NFG_LstLicencias` | 1000111 (`&Inicio=1`) | ✅ player licences (personal data!) |
| Documentos de Tramitación | `NFG_GC_DocumentosTramitacion` | 1001212 | ⚪ maybe |
| Gestión de Licencias | `NFG_GC_GestionLicencias` | 129 | ⛔ write actions |
| Directorio de Equipos | `NFG_LstDirectorioEquipos` | 1000165 | ✅ teams directory |
| Comparativa entre equipos | `NFG_LstComparativaEquipos` | 1001217 | ✅ head-to-head |
| Calendarios, Resultados y Clasificaciones | `NFG_CmpJornada` | 1000128 | ✅✅ **core** |
| Listado de Partidos (campos y horas) | `NFG_LstPartidos` | 1000139 | ✅✅ **core** – schedule, venues, times |
| Consulta de Sanciones | `NFG_ConsultaSanciones` | 1001218 | ✅ sanctions |
| Comunicación Online Sanciones | `NFG_CMP_LstCartasEquipos` | 1001219 | ✅ sanction letters |
| Liquidación online de clubes | `NFG_GC_LstLiquidaciones` | 1001202 | ⚪ club finances |
| Cambio de clave / firma, Correo Web | various | – | ⛔ out of scope |

### 1.5 Competition data model (the interesting part)
IDs observed for season **2026-2027**:

```
temporada (season)         22 = 2026-2027, 21 = 2025-2026, 20, 19, 18, 17, 15
 └─ competicion            323306 = LIGA DE VETERANOS F-S
     │                     323297 AFICIONADOS F-11 · 323299 AFICIONADOS F-7 · 323311 AFICIONADOS F-S
     │                     344859 JUVENILES F-S · 345659 INFANTILES F-S · 346365 BENJAMINES F-S · 344802 FEMENINA F-S
     └─ grupo              323307 PRIMERA · 323308 SEGUNDA · 323309 TERCERA A · 323310 TERCERA B
         └─ jornada        1..22  (1 = 27-09-2026 … 22 = 11-04-2027)
             └─ partido (acta)   CodActa e.g. 67512
equipo                     Codigo_Equipo e.g. 308793
```

Cascade endpoints (return `<script>` with `new Array("id","label",…)`):
- Competitions of a season: `NFG_CmpJornada_Exec?cod_primaria=1000128&codtemporada=22&cod_agrupacion=&Sch_Tipo_Juego=`
- Groups of a competition: `NFG_CmpJornada_Exec?cod_primaria=1000128&codcompeticion=323306&cod_agrupacion=`
- Rounds of a group: `NFG_CmpJornada_Exec?cod_primaria=1000128&codgrupo=323307&cod_agrupacion=`

Data pages (HTML tables to parse):
| Data | URL |
|---|---|
| Results of a round | `NFG_CmpJornada?cod_primaria=1000128&CodCompeticion=C&CodGrupo=G&CodTemporada=T&CodJornada=J` |
| Standings | `NFG_VisClasificacion?cod_primaria=1000128&codcompeticion=C&codgrupo=G&codjornada=J` |
| Full calendar | `NFG_VisCalendario_Vis?cod_primaria=1000128&codtemporada=T&codcompeticion=C&codgrupo=G` |
| Top scorers | `NFG_CMP_Goleadores?cod_primaria=1000128&codcompeticion=C&codtemporada=T&codgrupo=G&CodJornada=J` |
| Match sheet (line-ups, goals, cards, referee, venue) | `NFG_CmpPartido?cod_primaria=1000128&CodActa=A&cod_acta=A` |
| Team page (contact, kit, licences) | `NFG_VisEquipos?cod_primaria=1000102&Codigo_Equipo=E` |
| Head-to-head | `NFG_LstComparativaEquipos?cod_primaria=1001217&competicion=C&grupo=G&equipo1=E1&equipo2=E2` |
| Match list with filters (date range, club, venue…) | `NFG_LstPartidos?cod_primaria=1000139&Sch_…` (GET form, ~40 `Sch_*` filters) |

Built-in exports (handy, less fragile than scraping): append `&NPcd_File=1` (Word, actually HTML) or `&excel=1&NPcd_File=1` (Excel) to calendar/standings/scorers pages. Content-Type `application/msword` / Excel but body is HTML tables.

Standings columns observed: position, team, points, pts/game, home J/G/E/P, away J/G/E/P, goals for/against, last 5 results (G/E/P), sanction points.
Result colour codes on the site: green = in play, red = provisional, black = final.

### 1.6 Our club right now
"Mi Club" shows team **LOS PACHONES – LIGA DE VETERANOS F-S** flagged *"No está en competición"* for the current season. So for the demo we may want to show the league in general (e.g. Primera de Veteranos) and/or previous seasons (`temporada=21`) where the club did play. **To confirm with the colleague.**

### 1.7 Security / privacy notes
- Pages expose **personal data** of third parties (names, emails, phones of club contacts, full player lists, line-ups). The friendly view should show only what's needed (results, standings, schedule) and must not be published publicly without thinking about GDPR.
- The server reflects any `Origin` in `Access-Control-Allow-Origin` with `Allow-Credentials: true`. That's a weakness on their side; we should **not** rely on it (and it doesn't help anyway because the cookie is `SameSite=Lax` + HttpOnly).
- Credentials must live in env vars / a secret store, never in the HTML or the repo.
- Be gentle: cache aggressively, no crawling of everything, a few requests per minute at most. Check the RFFM/Novanet terms of use before going beyond internal use.

---

## 2. Can we just do a "plain HTML" page that loads from the site?

**Not directly.** A static page in the browser cannot:
1. log in and keep the cookie cross-site (HttpOnly + SameSite=Lax → the browser won't send it on `fetch` from our origin);
2. keep the connection-sticky session;
3. parse ISO-8859-15 HTML from another origin without a proxy.

So we need **a small backend piece** that logs in, fetches, parses and exposes clean JSON. The front-end can then be as plain as we like.

---

## 3. Proposed architecture

```
┌─────────────────────┐   JSON    ┌─────────────────────────┐  HTML (session)  ┌──────────────────┐
│ Friendly front-end  │ <──────── │  nfg-proxy (small API)  │ ───────────────> │ getafe.ffmadrid  │
│ static HTML/JS      │           │  login + scrape + cache │                  │ .es/nfg          │
└─────────────────────┘           └─────────────────────────┘                  └──────────────────┘
```

### Option A – Live proxy API (recommended to start)
- **Python + FastAPI** (`requests.Session` + `BeautifulSoup`/`selectolax`) — or Node + Express + `cheerio`; both fine, Python is quicker for the scraping part.
- Keeps one logged-in session, auto re-login when the login page is detected.
- In-memory/disk cache (e.g. 10 min for results on match days, 24 h for calendar/teams).
- Endpoints (JSON):
  - `GET /api/seasons`
  - `GET /api/competitions?season=22`
  - `GET /api/groups?competition=323306`
  - `GET /api/rounds?group=323307`
  - `GET /api/results?season=22&competition=…&group=…&round=…`
  - `GET /api/standings?…`
  - `GET /api/calendar?…`
  - `GET /api/scorers?…`
  - `GET /api/match/{acta}`
  - `GET /api/club` (our club summary, without personal contact data)
  - `GET /api/next-matches?team=…` (from `NFG_LstPartidos`)
- Front-end served by the same app → no CORS problems.

### Option B – Scheduled snapshot + static site
- A script (cron / GitHub Action) logs in every X hours, scrapes, writes `data/*.json`.
- A **pure static HTML** site reads those JSON files (can be hosted anywhere, even GitHub Pages — but mind the personal data).
- Simplest to run, zero server; data is "as of last run". Good if updates a few times a day are enough.

Both options share the same scraper module, so we can start with B (or A) and switch later.

### Front-end ("friendly view")
- Single page, mobile-first (people check results on their phone), Spanish UI.
- Plain HTML + a little JS (Alpine.js or vanilla) + simple CSS; no build step.
- Views / "items" to display:
  1. **Home / Mi equipo**: next match (date, time, venue), last result, position in the table.
  2. **Clasificación**: clean table, highlight our team, last-5 form badges.
  3. **Resultados por jornada**: round selector, match cards with status colour (en juego / provisional / definitivo).
  4. **Calendario**: whole season, filter "only my team".
  5. **Goleadores**: top scorers, filter by team.
  6. **Ficha de partido**: goals timeline, cards, line-ups.
  7. (Later) Sanciones, Comparativa entre equipos.
- Selector for season → competition → group (defaults saved in `localStorage`).

---

## 4. Implementation plan (phases)

| Phase | Work | Output |
|---|---|---|
| 0 | Review this doc; agree on Option A vs B, scope of "items", which team/season to showcase | decisions |
| 1 | **Scraper module**: session/login/re-login, fetch with throttle + cache, parsers for cascade arrays, results, standings, calendar, scorers, match sheet. Save sample HTML fixtures (anonymised) for unit tests | `nfg-view/scraper/` + tests |
| 2 | **API** (Option A) or **snapshot job** (Option B) on top of the scraper | `nfg-view/api/` or `nfg-view/jobs/` |
| 3 | **Front-end** static page(s) with the views above | `nfg-view/web/` |
| 4 | Config & secrets (`NFG_USER`, `NFG_PASS` via env), README, Docker file | runnable locally with one command |
| 5 | Hardening: error states when the site is down / layout changes, parser tests in CI | |

Suggested repo layout:
```
nfg-view/
  PLAN.md            ← this file
  scraper/           parsers + session client
  api/               FastAPI app (option A)
  web/               index.html, app.js, styles.css
  tests/fixtures/    anonymised HTML samples
  .env.example       NFG_USER= / NFG_PASS=  (no real values)
```

---

## 5. Risks
- **Fragile scraping**: any template change on Novanet breaks parsers → keep parsers small, test with fixtures, prefer the Excel/Word exports where possible (simpler tables).
- **Session stickiness** (see 1.2) → persistent connection + auto re-login.
- **Terms of use / account usage**: we use a real club account; heavy automated use might be noticed or blocked. Throttle + cache.
- **Personal data** (GDPR) → filter fields, keep the app private unless only public-type info (results/standings) is shown.
- Encoding ISO-8859-15 → decode explicitly.

---

## 6. Open questions for review
1. Option **A (live API)** or **B (scheduled snapshot + static HTML)**? My suggestion: start with **B** for a quick demo, the same scraper later powers A.
2. Which items matter most to your colleague? (my proposed MVP: next match, standings, results per round, calendar, top scorers)
3. Which competition/group/season to showcase, given LOS PACHONES shows "No está en competición" this season?
4. Where will it run (local laptop, a small VPS, internal server)? Private or public?
5. Python or Node for the backend?
6. Do we need club-management sections (licences, sanctions, finances), or only competition info?
