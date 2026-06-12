// Time-to-coverage on a dense local fixture: load + content swap.
import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve } from 'node:path';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const EXT = resolve('dist/firefox');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = '/tmp/branchkit-ff-coverage';
if (existsSync(profile)) rmSync(profile, { recursive: true });
mkdirSync(profile, { recursive: true });

const page_html = (gen) => `<!doctype html><html><body>
<div id="grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px">
${Array.from({length: 400}, (_, i) => `<a href="/x/${gen}/${i}" style="padding:6px;border:1px solid #ccc">item ${gen}-${i}</a>`).join('\n')}
</div>
<script>window.swap = (g) => { document.getElementById('grid').innerHTML =
  Array.from({length: 400}, (_, i) => '<a href="/x/'+g+'/'+i+'" style="padding:6px;border:1px solid #ccc">item '+g+'-'+i+'</a>').join('');};</script>
</body></html>`;
const server = createServer((req, res) => { res.setHeader('content-type','text/html'); res.end(page_html('A')); });
await new Promise(r => server.listen(8923, r));

const ctx = await withExtension(firefox, EXT).launchPersistentContext(profile, { headless: false, viewport: { width: 1200, height: 850 } });
const page = await ctx.newPage();
await page.goto('http://localhost:8923/', { waitUntil: 'domcontentloaded' });
await page.bringToFront();

async function curve(label, maxMs) {
  const t0 = Date.now();
  let last = -1;
  const samples = [];
  while (Date.now() - t0 < maxMs) {
    const shown = await page.evaluate(() => document.querySelectorAll('[data-branchkit-hint][data-bk-shown]').length);
    samples.push([Date.now() - t0, shown]);
    if (shown !== last) last = shown;
    await sleep(250);
  }
  const final = samples[samples.length - 1][1];
  const t95 = samples.find(([, s]) => s >= final * 0.95)?.[0] ?? -1;
  const t50 = samples.find(([, s]) => s >= final * 0.5)?.[0] ?? -1;
  console.log(`${label}: final=${final} t50=${t50}ms t95=${t95}ms  curve=${samples.filter((_,i)=>i%4===0).map(([t,s])=>`${t}:${s}`).join(' ')}`);
}

await curve('load', 12000);
await page.evaluate(() => window.swap('B'));
await curve('swap', 12000);
await ctx.close();
server.close();
