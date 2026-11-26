// Drives the running simulator through the full flow and saves one glasses screenshot per step.
// Needs: `npm run dev` and a simulator in demo mode with --automation-port 9898 (`npm run sim`).
// Plays demo/flow.json (tests/demo-flow.test.ts replays the same file against the app, so it cannot drift).
// Output: demo/steps/NN-name.png and demo/steps.json (captions + hold times for make-video.sh).
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const BASE = process.env.SIM ?? 'http://127.0.0.1:9898';
const OUT = 'demo/steps';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const input = (action) =>
  fetch(`${BASE}/api/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
const shot = async (file) => {
  const res = await fetch(`${BASE}/api/screenshot/glasses`);
  await writeFile(`${OUT}/${file}`, Buffer.from(await res.arrayBuffer()));
};

await mkdir(OUT, { recursive: true });
const flow = JSON.parse(await readFile('demo/flow.json', 'utf8'));
const steps = [];
let n = 0;
for (const f of flow) {
  for (const a of f.actions) {
    await input(a);
    await sleep(a === 'click' ? Math.min(f.wait, 700) : 400);
  }
  await sleep(f.wait);
  const file = `${String(++n).padStart(2, '0')}-${f.name}.png`;
  await shot(file);
  steps.push({ file, caption: f.caption, hold: f.hold });
}
await writeFile('demo/steps.json', JSON.stringify(steps, null, 2));
console.log(`saved ${steps.length} steps in ${OUT}`);
