// NFG (Novanet) client + parsers. No framework dependencies besides cheerio.
// Runs inside a serverless function: logs in, fetches HTML pages, returns plain JSON.
import * as cheerio from 'cheerio';
import { fetch, Client } from 'undici';
import http from 'node:http';
import tls from 'node:tls';

const ORIGIN = 'https://getafe.ffmadrid.es';
const BASE = ORIGIN + '/nfg/';
const UA = 'Mozilla/5.0 (compatible; nfg-friendly-view/0.1)';
const CMP = '1000128'; // cod_primaria of "Calendarios, Resultados y Clasificaciones"

// The one team this app is for. Update these IDs each season (or override with env vars).
// How to find them: see PLAN.md, section 1.5.
export const TEAM = {
  id: process.env.NFG_TEAM_ID || '308870', // LOS PACHONES
  name: process.env.NFG_TEAM_NAME || 'LOS PACHONES',
  season: process.env.NFG_SEASON || '22', // 2026-2027
  competition: process.env.NFG_COMPETITION || '323306', // LIGA DE VETERANOS F-S
  group: process.env.NFG_GROUP || '323310', // TERCERA DE VETERANOS F-S GRUPO B
};

// Module-level state survives between invocations while the function stays warm.
let cookie = '';

// NFG ties the login session to the TCP connection (sticky load balancing): a new connection
// gets a new, anonymous session. So all requests go through ONE undici Client = one kept-alive
// connection. If that connection drops, page() notices the login screen and logs in again.
//
// HTTPS_PROXY is only for local runs behind a corporate/sandbox proxy (Vercel has none).
// undici's ProxyAgent opens a new tunnel per request, so we open the tunnel ourselves.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;

function tunnelConnect({ hostname, port }, callback) {
  const p = new URL(proxy);
  const target = `${hostname}:${port || 443}`;
  const req = http.request({ host: p.hostname, port: p.port, method: 'CONNECT', path: target });
  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) return callback(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
    const secure = tls.connect({ socket, servername: hostname, ALPNProtocols: ['http/1.1'] }, () =>
      callback(null, secure),
    );
    secure.once('error', callback);
  });
  req.once('error', callback);
  req.end();
}

// The site answers "Keep-Alive: timeout=2" (idle connections are closed after 2 s). undici
// subtracts keepAliveTimeoutThreshold (default 2 s) from that hint and would close the socket
// after every response, so keep the margin small. Requests inside one invocation run back to
// back, well within 2 s; after a longer idle gap the next call simply logs in again.
const dispatcher = new Client(ORIGIN, {
  keepAliveTimeout: 2_000,
  keepAliveTimeoutThreshold: 300,
  pipelining: 1,
  ...(proxy ? { connect: tunnelConnect } : {}),
});

const isLoginPage = (html) => html.includes('Novanet | Login');
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const num = (s) => {
  if (clean(s) === '') return null; // empty cell = no score yet (Number('') would be 0)
  const n = Number(clean(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function storeCookies(res) {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const m = c.match(/^JSESSIONID=([^;]+)/);
    if (m) cookie = `JSESSIONID=${m[1]}`;
  }
}

async function raw(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
    redirect: 'manual',
    dispatcher,
  });
  storeCookies(res);
  const buf = await res.arrayBuffer();
  return new TextDecoder('iso-8859-15').decode(buf);
}

export async function login() {
  const user = process.env.NFG_USER;
  const pass = process.env.NFG_PASS;
  if (!user || !pass) throw new Error('NFG_USER / NFG_PASS are not configured');
  cookie = '';
  await raw(''); // get a fresh JSESSIONID
  const body = new URLSearchParams({ NUser: user, NPass: pass, LoginAjax: '1', N_Ajax: '1' });
  const out = await raw('NLogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!/estado\s*=\s*"1"/.test(out)) throw new Error('Login rejected by NFG');
}

// GET an authenticated page; logs in (again) when the site answers with its login screen.
export async function page(path) {
  if (!cookie) await login();
  let html = await raw('NPcd/' + path);
  if (isLoginPage(html)) {
    await login();
    html = await raw('NPcd/' + path);
    if (isLoginPage(html)) throw new Error('Session not kept by NFG after login');
  }
  return html;
}

// ---------- parsers (pure functions: html string -> data) ----------

// Rounds cascade answers with: new Array("id","label",...) and labels like "  1 - 27-09-2026  ".
export function parseRounds(html) {
  const live = html.replace(/^\s*\/\/.*$/gm, ''); // ignore commented-out JS lines
  const m = live.match(/new Array\(([\s\S]*?)\)/);
  if (!m) return [];
  const items = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  const out = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    const d = clean(items[i + 1]).match(/^(\d+)\s*-\s*(\d{2}-\d{2}-\d{4})/);
    if (items[i] !== '0' && d) out.push({ round: Number(d[1]), date: d[2] });
  }
  return out;
}

export function parseStandings(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const rows = [];
  $('tr[id]').each((_, tr) => {
    const m = $(tr).attr('id').match(/^(\d+)_\d+$/);
    if (!m || seen.has(m[1])) return;
    const td = $(tr).children('td');
    if (td.length < 15) return;
    seen.add(m[1]);
    const t = (i) => clean(td.eq(i).text());
    const sum = (a, b) => (num(t(a)) ?? 0) + (num(t(b)) ?? 0);
    rows.push({
      teamId: m[1],
      position: num(t(1)),
      team: clean($(tr).find(`#${m[1]}_nombre`).text()) || t(2),
      points: num(t(3)),
      played: sum(5, 9),
      won: sum(6, 10),
      drawn: sum(7, 11),
      lost: sum(8, 12),
      goalsFor: num(t(13)),
      goalsAgainst: num(t(14)),
      form: td.eq(15).find('span').map((_, s) => clean($(s).text())).get().filter(Boolean),
    });
  });
  return rows;
}

// Season calendar: one <div id="trPartidosJornada_N"> per round, date in <span id="fecha_jornada_org_N">,
// rows <tr id="<acta>"><td>home</td><td>goals</td><td>-</td><td>goals</td><td>away</td>...
export function parseCalendar(html) {
  const $ = cheerio.load(html);
  const matches = [];
  $('div[id^="trPartidosJornada_"]').each((_, div) => {
    const round = Number($(div).attr('id').split('_')[1]);
    const date = (clean($(div).find(`#fecha_jornada_org_${round}`).text()).match(/\d{2}-\d{2}-\d{4}/) || [])[0] || null;
    $(div)
      .find('tr')
      .filter((_, tr) => /^\d+$/.test($(tr).attr('id') || ''))
      .each((_, tr) => {
        const td = $(tr).children('td');
        if (td.length < 5) return;
        matches.push({
          acta: $(tr).attr('id'),
          round,
          roundDate: date,
          home: clean(td.eq(0).text()),
          away: clean(td.eq(4).text()),
          homeGoals: num(td.eq(1).text()),
          awayGoals: num(td.eq(3).text()),
        });
      });
  });
  return matches;
}

const STATUS = { resultado_cerrada: 'final', resultado_prov: 'provisional', resultado_enjuego: 'live' };

// One round page: each match is a <div class="portlet-body body_fed"><table>...</table></div>.
// Played matches have scores and a match-sheet link; upcoming ones only date, time and venue.
export function parseRound(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const matches = [];
  $('div.portlet-body.body_fed > table').each((_, table) => {
    const teams = $(table).find('a[href*="NFG_VisEquipos"]');
    if (teams.length < 2) return;
    const home = clean($(teams[0]).text());
    const away = clean($(teams[1]).text());
    if (seen.has(home + '|' + away)) return;
    seen.add(home + '|' + away);
    const scores = $(table).find('span[class^="resultado_"]');
    const when = $(table).find('span.esconder').map((_, s) => clean($(s).text())).get();
    matches.push({
      home,
      away,
      status: STATUS[scores.first().attr('class')] || (scores.length ? 'unknown' : 'scheduled'),
      date: when.find((w) => /^\d{2}-\d{2}-\d{4}$/.test(w)) || null,
      time: when.find((w) => /^\d{1,2}:\d{2}$/.test(w)) || null,
      venue: (clean($(table).text()).match(/Campo:\s*(.+?)(?:\s+-\s+\w+)?$/) || [])[1] || null,
    });
  });
  return matches;
}

// ---------- the only view: everything the team page needs ----------

const toDate = (d) => {
  const [dd, mm, yy] = (d || '').split('-').map(Number);
  return new Date(yy, mm - 1, dd);
};

const roundUrl = (round) =>
  `NFG_CmpJornada?cod_primaria=${CMP}&CodCompeticion=${TEAM.competition}&CodGrupo=${TEAM.group}` +
  `&CodTemporada=${TEAM.season}&CodJornada=${round}&cod_agrupacion=&Sch_Tipo_Juego=`;

export async function teamView({ upcomingDetails = 3, now = new Date() } = {}) {
  const rounds = parseRounds(await page(`NFG_CmpJornada_Exec?cod_primaria=${CMP}&codgrupo=${TEAM.group}&cod_agrupacion=`));
  const calendar = parseCalendar(
    await page(
      `NFG_VisCalendario_Vis?cod_primaria=${CMP}&codtemporada=${TEAM.season}` +
        `&codcompeticion=${TEAM.competition}&codgrupo=${TEAM.group}`,
    ),
  );

  // Standings after the last round whose date has passed.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastRound = rounds.filter((r) => toDate(r.date) <= today).at(-1)?.round ?? 1;
  const standingsHtml = await page(
    `NFG_VisClasificacion?cod_primaria=${CMP}&codcompeticion=${TEAM.competition}` +
      `&codgrupo=${TEAM.group}&codjornada=${lastRound}`,
  );
  const groupName = (clean(cheerio.load(standingsHtml)('body').text()).match(/LIGA DE VETERANOS F-S,\s*([^]+?)\s+Temporada\s+(\S+)/) || []);

  const ours = calendar.filter((m) => m.home === TEAM.name || m.away === TEAM.name);
  const toMatch = (m) => {
    const home = m.home === TEAM.name;
    const gf = home ? m.homeGoals : m.awayGoals;
    const ga = home ? m.awayGoals : m.homeGoals;
    return {
      round: m.round,
      date: m.roundDate,
      time: null,
      venue: null,
      status: gf === null ? 'scheduled' : 'final',
      home,
      opponent: home ? m.away : m.home,
      goalsFor: gf,
      goalsAgainst: ga,
      outcome: gf === null ? null : gf > ga ? 'W' : gf < ga ? 'L' : 'D',
    };
  };
  const results = ours.filter((m) => m.homeGoals !== null).map(toMatch).reverse(); // newest first
  const upcoming = ours.filter((m) => m.homeGoals === null).map(toMatch);

  // Exact date/time/venue for the next few matches, and live/provisional status of the latest result.
  const detailRounds = [...upcoming.slice(0, upcomingDetails), ...results.slice(0, 1)];
  for (const m of detailRounds) {
    const found = parseRound(await page(roundUrl(m.round))).find(
      (x) => x.home === TEAM.name || x.away === TEAM.name,
    );
    if (!found) continue;
    m.date = found.date || m.date;
    m.time = found.time;
    m.venue = found.venue;
    if (m.status !== 'scheduled' || found.status === 'live') m.status = found.status === 'scheduled' ? m.status : found.status;
  }

  return {
    team: TEAM.name,
    group: groupName[1] || null,
    season: groupName[2] || null,
    standingsAfterRound: lastRound,
    standings: parseStandings(standingsHtml),
    upcoming,
    results,
  };
}

// Platform-neutral entry point: params object in, { status, body } out.
export async function handle(params = {}) {
  if (process.env.APP_KEY && params.key !== process.env.APP_KEY) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  try {
    return { status: 200, body: { data: await teamView(), fetchedAt: new Date().toISOString() } };
  } catch (e) {
    return { status: e.status || 502, body: { error: e.message } };
  }
}
