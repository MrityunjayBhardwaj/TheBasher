import { chromium } from 'playwright';

const out = process.argv[2] || '/tmp/basher-shot.png';
const mode = process.argv[3] || 'editor'; // 'editor' | 'home'

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1728, height: 1080 } });

await page.addInitScript((m) => {
  if (m === 'home') {
    localStorage.clear();
  } else {
    localStorage.setItem('basher.lastProjectId', 'example_starter');
    localStorage.removeItem('basher.chrome.v1');
  }
}, mode);

await page.goto('http://localhost:5180', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
console.log('shot →', out);
await browser.close();
