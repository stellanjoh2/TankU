// Headless smoke test: load the prototype, drive, turn, fire, and screenshot each phase.
//   node tools/smoke.mjs [url]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? `${process.env.HOME}/Cursor/meshgl/node_modules/playwright`);
const url = process.argv[2] ?? 'http://localhost:5173/';
const out = new URL('../screens/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url);
await page.waitForFunction(() => window.__sherman, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const state = () => page.evaluate(() => {
  const { tank } = window.__sherman;
  const p = tank.body.translation();
  const q = tank.body.rotation();
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yawDeg: +(yaw * 57.3).toFixed(1),
           kmh: +(tank.forwardSpeed() * 3.6).toFixed(1), grounded: tank.grounded,
           trackL: +tank.sides[0].dist.toFixed(2), trackR: +tank.sides[1].dist.toFixed(2),
           turretDeg: +(tank.turret.rotation.y * 57.3).toFixed(1) };
});

const log = async (label) => console.log(label.padEnd(14), JSON.stringify(await state()));
await log('settled');
await page.screenshot({ path: `${out}0_spawn.png` });

await page.keyboard.down('KeyW');
await page.waitForTimeout(3000);
await log('W 3s');
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(2500);
await log('W+Shift 2.5s');
await page.screenshot({ path: `${out}1_driving.png` });
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('KeyW');
await page.waitForTimeout(2500);
await log('coast/brake');

await page.keyboard.down('KeyD');
await page.waitForTimeout(2500);
await page.keyboard.up('KeyD');
await log('pivot D 2.5s');

await page.evaluate(() => { window.__sherman.CAM.yaw += 1.2; });
await page.waitForTimeout(2500);
await log('turret aim');
await page.evaluate(() => { window.__sherman.input.mouseFire = true; });
await page.waitForTimeout(120);
await page.screenshot({ path: `${out}2_fire.png` });
await page.evaluate(() => { window.__sherman.input.mouseFire = false; });
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}3_impact.png` });
await log('after fire');

console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
