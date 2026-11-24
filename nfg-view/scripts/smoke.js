// Calls the API logic against the real site and prints a summary.
// Usage: NFG_USER=... NFG_PASS=... node scripts/smoke.js
import { handle } from '../lib/nfg.js';

const t = Date.now();
const { status, body } = await handle();
console.log(`status ${status} in ${Date.now() - t} ms`);
if (status !== 200) process.exit(1);
const d = body.data;
console.log(d.team, '|', d.group, '|', d.season, '| standings after round', d.standingsAfterRound);
console.log('\nStandings:');
for (const r of d.standings) console.log(` ${r.position}. ${r.team} ${r.points} pts (${r.played} PJ) ${r.goalsFor}:${r.goalsAgainst} ${r.form.join('')}`);
console.log('\nUpcoming:');
for (const m of d.upcoming) console.log(` J${m.round} ${m.date} ${m.time ?? ''} ${m.home ? 'vs' : '@'} ${m.opponent} ${m.venue ?? ''}`);
console.log('\nResults:');
for (const m of d.results) console.log(` J${m.round} ${m.date} ${m.home ? 'vs' : '@'} ${m.opponent} ${m.goalsFor}-${m.goalsAgainst} ${m.outcome} ${m.status}`);
