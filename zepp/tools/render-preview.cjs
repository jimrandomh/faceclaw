// Desktop render of the real watch widgets, with fixture state. Not a
// simulator or a hardware screenshot. Playwright is intentionally optional.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const { watchFixture, sampleState } = await import(pathToFileURL(path.join(root, 'test/fixture.mjs')));
  const w = watchFixture(); await w.reply();
  const snapshot = label => ({ label, widgets: JSON.parse(JSON.stringify(w.widgets)) });
  const snapshots = [snapshot('Touchpad')];
  w.page.tray = true; w.page.render(); snapshots.push(snapshot('Apps & status'));
  w.page.navigate('apps'); await w.reply(); snapshots.push(snapshot('Open windows'));
  w.page.select(4); snapshots.push(snapshot('Launch apps'));
  w.page.navigate('status'); await w.reply(); snapshots.push(snapshot('Glasses & phone'));
  w.page.navigate('remote'); w.page.tray = false; w.page.phoneState = null; w.page.linkError = 'Add your input token in Zepp → Faceclaw Remote settings.'; w.page.navigate('details'); snapshots.push(snapshot('Setup needed'));
  w.page.navigate('help'); snapshots.push(snapshot('Controls & exit'));
  w.page.onDestroy();
  const browser = await chromium.launch({ headless: true });
  try {
    const tab = await browser.newPage({ viewport: { width: 1552, height: 1204 }, deviceScaleFactor: 1 });
    await tab.setContent('<style>body{margin:0;padding:20px;background:#11151b;color:#dbe6f4;font-family:Arial,sans-serif}h1{text-align:center;font-size:28px;margin:0 0 10px}p{text-align:center;color:#a8b5c5;margin:0 0 18px}.grid{display:grid;grid-template-columns:repeat(3,480px);gap:22px 36px}h2{text-align:center;font-size:20px;font-weight:400;margin:8px 0 14px}.watch{position:relative;width:480px;height:480px;overflow:hidden;border-radius:50%;background:#000;box-shadow:0 0 0 2px #3c414a}.widget{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.15;white-space:pre-wrap}.button{white-space:nowrap}.widget span{max-width:100%}</style><h1>Faceclaw Remote · Amazfit Balance</h1><p>Sample data from the real watch layout. Hardware testing still required.</p><div class="grid"></div>');
    await tab.evaluate(snapshots => {
      const color = n => '#' + (n || 0).toString(16).padStart(6, '0');
      for (const s of snapshots) {
        const item = document.createElement('section'), title = document.createElement('h2'), watch = document.createElement('div');
        title.textContent = s.label; watch.className = 'watch'; item.append(title, watch); document.querySelector('.grid').append(item);
        for (const { type, props: p } of s.widgets) {
          if (p.visible === false) continue;
          const el = document.createElement('div'); el.className = 'widget ' + type;
          Object.assign(el.style, { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px', fontSize: (p.text_size || 0) + 'px', color: color(p.color), borderRadius: (p.radius || 0) + 'px', background: type === 'button' ? color(p.normal_color) : type === 'rect' ? color(p.color) : 'transparent' });
          if (p.text) { const span = document.createElement('span'); span.textContent = p.text; el.append(span); }
          watch.append(el);
        }
      }
    }, snapshots);
    const overflow = await tab.locator('.widget').evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1).map(n => n.textContent));
    const clipped = await tab.locator('.widget span').evaluateAll(nodes => nodes.filter(n => {
      const w = n.closest('.watch').getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(n);
      return [...range.getClientRects()].some(r => [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]].some(([x, y]) => Math.hypot(x - w.left - 240, y - w.top - 240) > 238));
    }).map(n => n.textContent));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    await tab.screenshot({ path: path.join(root, 'docs/watch-preview.png'), fullPage: true });
    for (let i = 0; i < snapshots.length; i++) await tab.locator('.watch').nth(i).screenshot({ path: path.join(root, 'docs/watch-' + i + '.png') });
    if (overflow.length || clipped.length) throw new Error('Text overflow: ' + overflow.join('; ') + '. Round-screen clipping: ' + clipped.join('; '));
    console.log('Seven watch layouts checked: no text overflow or circular-screen text clipping.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
