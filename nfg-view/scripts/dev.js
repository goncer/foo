// Local stand-in for Vercel: serves public/ and /api/nfg on http://localhost:3000
// Usage: NFG_USER=... NFG_PASS=... npm run dev
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { handle } from '../lib/nfg.js';

const port = Number(process.env.PORT || 3000);
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/nfg') {
      const { status, body } = await handle(Object.fromEntries(url.searchParams));
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(body));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('../public/index.html', import.meta.url)));
    }
    res.writeHead(404).end('Not found');
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
