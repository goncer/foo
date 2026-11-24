// Calls every view against the real site and prints a short summary.
// Usage: NFG_USER=... NFG_PASS=... node scripts/smoke.js
import { handle } from '../lib/nfg.js';

const base = { season: '22', competition: '323306', group: '323307', round: '8' };
const calls = [
  { view: 'seasons' },
  { view: 'competitions', season: base.season },
  { view: 'groups', competition: base.competition },
  { view: 'rounds', group: base.group },
  { view: 'results', ...base, round: '1' },
  { view: 'standings', ...base },
  { view: 'scorers', ...base },
];

for (const c of calls) {
  const t = Date.now();
  const { status, body } = await handle(c);
  const data = body.data;
  console.log(`\n## ${c.view} -> ${status} in ${Date.now() - t} ms, ${Array.isArray(data) ? data.length + ' items' : body.error}`);
  if (Array.isArray(data)) console.log(JSON.stringify(data.slice(0, 2), null, 1));
}
