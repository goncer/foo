# nfg-view

Friendly, mobile-first view of the NFG Getafe competition data (results, standings, top scorers).
Data loads **live** from `getafe.ffmadrid.es/nfg` through a **serverless function**. There is no server to maintain.
See [PLAN.md](PLAN.md) for the investigation notes and design.

```
api/nfg.js         Vercel function: GET /api/nfg?view=...
lib/nfg.js         NFG client (login, single connection, re-login) + HTML parsers
public/index.html  the page (plain HTML + JS)
scripts/dev.js     local stand-in for Vercel (serves page + API on :3000)
scripts/smoke.js   calls every view against the real site
```

## Run locally

```bash
npm install
```

```bash
NFG_USER=your_user NFG_PASS=your_password npm run dev
```

Open http://localhost:3000. To just check the API against the live site:

```bash
NFG_USER=your_user NFG_PASS=your_password npm run smoke
```

## Deploy (Vercel)

1. Import the repository in Vercel and set **Root Directory** to `nfg-view` (framework preset: *Other*).
2. Add environment variables `NFG_USER`, `NFG_PASS` and, optionally, `APP_KEY`. With `APP_KEY` set, open the page as `https://<app>.vercel.app/?key=<APP_KEY>`.
3. Deploy. The page is served from `public/`, the API from `api/nfg.js`.

Never commit real credentials. `.env` is git-ignored, and `.env.example` lists the variables.
