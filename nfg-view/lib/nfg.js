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

// Cascade endpoints answer with: new Array("id","label","id","label",...)
export function parseArray(html) {
  const live = html.replace(/^\s*\/\/.*$/gm, ''); // ignore commented-out JS lines
  const m = live.match(/new Array\(([\s\S]*?)\)/);
  if (!m) return [];
  const items = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  const out = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    if (items[i] !== '0' && items[i] !== '') out.push({ id: items[i], name: clean(items[i + 1]) });
  }
  return out;
}

// The competitions cascade injects a <select> as an HTML string instead of an array.
export function parseOptions(html) {
  const out = [];
  for (const m of html.matchAll(/<option value='?"?(\d+)'?"?>([^<]*)</g)) {
    if (m[1] !== '0') out.push({ id: m[1], name: clean(m[2]) });
  }
  return out.length ? out : parseArray(html);
}

export function parseSeasons(html) {
  const $ = cheerio.load(html);
  return $('select[name="temporada"] option')
    .map((_, o) => ({ id: $(o).attr('value'), name: clean($(o).text()) }))
    .get();
}

export function parseRounds(html) {
  return parseArray(html).map((r) => {
    const m = r.name.match(/^(\d+)\s*-\s*(\S+)/);
    return { id: r.id, number: m ? Number(m[1]) : Number(r.id), date: m ? m[2] : null };
  });
}

export function parseStandings(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const rows = [];
  $('tr[id]').each((_, tr) => {
    const id = $(tr).attr('id');
    const m = id.match(/^(\d+)_\d+$/);
    if (!m || seen.has(m[1])) return;
    const td = $(tr).children('td');
    if (td.length < 15) return;
    seen.add(m[1]);
    const t = (i) => clean(td.eq(i).text());
    rows.push({
      teamId: m[1],
      position: num(t(1)),
      team: clean($(tr).find(`#${m[1]}_nombre`).text()) || t(2),
      points: num(t(3)),
      pointsPerGame: num(t(4)),
      home: { played: num(t(5)), won: num(t(6)), drawn: num(t(7)), lost: num(t(8)) },
      away: { played: num(t(9)), won: num(t(10)), drawn: num(t(11)), lost: num(t(12)) },
      goalsFor: num(t(13)),
      goalsAgainst: num(t(14)),
      form: td.eq(15).find('span').map((_, s) => clean($(s).text())).get().filter(Boolean),
      sanctionPoints: num(t(16)),
    });
  });
  return rows;
}

const STATUS = { resultado_cerrada: 'final', resultado_prov: 'provisional', resultado_enjuego: 'live' };

export function parseResults(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const matches = [];
  $('a[href*="NFG_CmpPartido"]').each((_, a) => {
    const acta = ($(a).attr('href').match(/CodActa=(\d+)/) || [])[1];
    if (!acta || seen.has(acta)) return;
    // Match block = the table whose first row holds both teams and the score.
    const block = $(a).closest('table').parents('table').first();
    const teams = block.find('a[href*="NFG_VisEquipos"]');
    if (teams.length < 2) return;
    seen.add(acta);
    const scores = block.find('span[class^="resultado_"]');
    const goals = scores.map((_, s) => num($(s).text().replace('-', ''))).get();
    const status = STATUS[scores.first().attr('class')] || (scores.length ? 'unknown' : 'pending');
    const when = block.find('span.esconder').map((_, s) => clean($(s).text())).get();
    const venue = (clean(block.text()).match(/Campo:\s*(.+?)(?:\s{2,}|$)/) || [])[1] || null;
    const teamId = (el) => ($(el).attr('href').match(/Codigo_Equipo=(\d+)/) || [])[1];
    matches.push({
      acta,
      home: { id: teamId(teams[0]), name: clean($(teams[0]).text()) },
      away: { id: teamId(teams[1]), name: clean($(teams[1]).text()) },
      homeGoals: goals[0] ?? null,
      awayGoals: goals[1] ?? null,
      status,
      date: when.find((w) => /^\d{2}-\d{2}-\d{4}$/.test(w)) || null,
      time: when.find((w) => /^\d{1,2}:\d{2}$/.test(w)) || null,
      venue,
    });
  });
  return matches;
}

export function parseScorers(html) {
  const $ = cheerio.load(html);
  const table = $('th')
    .filter((_, th) => clean($(th).text()) === 'Jugador')
    .first()
    .closest('table');
  return table
    .find('tr')
    .filter((_, tr) => $(tr).children('td').length >= 6)
    .map((_, tr) => {
      const t = (i) => clean($(tr).children('td').eq(i).text());
      return { player: t(0), team: t(1), group: t(2), played: num(t(3)), goals: num(t(4)), goalsPerGame: num(t(5)) };
    })
    .get();
}

// ---------- public API used by the function ----------

const ID = /^\d{1,9}$/;
function need(params, ...keys) {
  for (const k of keys) {
    if (!ID.test(params[k] ?? '')) throw Object.assign(new Error(`Missing or invalid "${k}"`), { status: 400 });
  }
}

export const views = {
  async seasons() {
    return parseSeasons(await page(`NFG_CmpJornada?cod_primaria=${CMP}`));
  },
  async competitions(p) {
    need(p, 'season');
    return parseOptions(
      await page(`NFG_CmpJornada_Exec?cod_primaria=${CMP}&codtemporada=${p.season}&cod_agrupacion=&Sch_Tipo_Juego=`),
    );
  },
  async groups(p) {
    need(p, 'competition');
    return parseArray(await page(`NFG_CmpJornada_Exec?cod_primaria=${CMP}&codcompeticion=${p.competition}&cod_agrupacion=`));
  },
  async rounds(p) {
    need(p, 'group');
    return parseRounds(await page(`NFG_CmpJornada_Exec?cod_primaria=${CMP}&codgrupo=${p.group}&cod_agrupacion=`));
  },
  async results(p) {
    need(p, 'season', 'competition', 'group', 'round');
    return parseResults(
      await page(
        `NFG_CmpJornada?cod_primaria=${CMP}&CodCompeticion=${p.competition}&CodGrupo=${p.group}` +
          `&CodTemporada=${p.season}&CodJornada=${p.round}&cod_agrupacion=&Sch_Tipo_Juego=`,
      ),
    );
  },
  async standings(p) {
    need(p, 'competition', 'group', 'round');
    return parseStandings(
      await page(
        `NFG_VisClasificacion?cod_primaria=${CMP}&codcompeticion=${p.competition}&codgrupo=${p.group}&codjornada=${p.round}`,
      ),
    );
  },
  async scorers(p) {
    need(p, 'season', 'competition', 'group', 'round');
    return parseScorers(
      await page(
        `NFG_CMP_Goleadores?cod_primaria=${CMP}&CodJornada=${p.round}&codcompeticion=${p.competition}` +
          `&codtemporada=${p.season}&codgrupo=${p.group}`,
      ),
    );
  },
};

// Platform-neutral entry point: params object in, { status, body } out.
export async function handle(params) {
  if (process.env.APP_KEY && params.key !== process.env.APP_KEY) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  const fn = views[params.view];
  if (!fn) return { status: 400, body: { error: `Unknown view. Use one of: ${Object.keys(views).join(', ')}` } };
  try {
    return { status: 200, body: { view: params.view, data: await fn(params), fetchedAt: new Date().toISOString() } };
  } catch (e) {
    return { status: e.status || 502, body: { error: e.message } };
  }
}
