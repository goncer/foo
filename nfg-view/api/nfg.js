// Vercel serverless function: GET /api/nfg?view=standings&season=22&competition=323306&group=323307&round=8
import { handle } from '../lib/nfg.js';

export default async function handler(req, res) {
  const { status, body } = await handle(req.query || {});
  // Let the CDN reuse an answer for 60 s so many viewers don't each hit the federation site.
  if (status === 200) res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.status(status).json(body);
}
