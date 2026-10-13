// End-to-end tests on real (generated) images: cutting, colour, transparency, safety and hosting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { runCut, runHost, iccDescription } from '../cut-email.mjs';
import { UserError } from '../lib.mjs';
import { tempDir, makeSyntheticMaster, bandsRaw, addIccToPng, displayP3Profile, p3ToSrgb, pixelAt, maxDiff, collectLog } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, '..', 'cut-email.mjs');
const ADDRESS = 'Test Pty Ltd, 1 Test Street, Sydney NSW 2000';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let dir;
let master; // { file, data, width, height }

before(async () => {
  dir = await tempDir();
  const file = path.join(dir, 'master.png');
  const made = await makeSyntheticMaster(file);
  master = { file, ...made };
});
after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

// Design rows for the 1200 x 3000 synthetic master (600 x 1500 in Paper).
const syntheticRows = () => [
  { name: 'gradient', to: 300, link: 'https://shop.example/', alt: 'Gradient header' },
  { name: 'orange', to: 400, link: 'https://shop.example/offer', alt: 'Orange band' },
  { name: 'photo', to: 800, link: 'https://shop.example/photo', alt: 'Photo-like texture' },
  {
    name: 'nav',
    to: 900,
    columns: [
      { width: 200, link: 'https://shop.example/a', alt: 'Left' },
      { width: 400, link: 'https://shop.example/b', alt: 'Right' },
    ],
  },
  { name: 'rest', to: 'end', link: 'https://shop.example/rest', alt: 'Diagonal' },
  { live: 'footer', address: ADDRESS },
];

async function writeCuts(name, settings) {
  const p = path.join(dir, `${name}.json`);
  await fs.writeFile(p, JSON.stringify({ name, platform: 'omnisend', ...settings }, null, 2));
  return p;
}

async function decode(file) {
  return sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

/** Compares a decoded strip with the same region of an independent raw source. Returns per-channel mean absolute error. */
function compareRegion(src, srcWidth, srcChannels, strip, px) {
  const sums = [0, 0, 0];
  let differing = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++)
      for (let c = 0; c < 3; c++) {
        const a = src[((px.top + y) * srcWidth + px.left + x) * srcChannels + c];
        const b = strip.data[(y * px.width + x) * 3 + c];
        if (a !== b) differing++;
        sums[c] += Math.abs(a - b);
      }
  const n = px.width * px.height;
  return { differing, mae: sums.map((s) => s / n) };
}

test('PNG strips: heights add up, columns cut correctly, and everything reassembles exactly', async () => {
  const cuts = await writeCuts('png-run', { format: 'png', rows: syntheticRows() });
  const out = path.join(dir, 'out-png');
  const log = collectLog();
  const r = await runCut({ master: master.file, cuts, out, log });

  const stripFiles = readdirSync(path.join(out, 'strips')).sort();
  assert.deepEqual(stripFiles, [
    '01-gradient@2x.png',
    '02-orange@2x.png',
    '03-photo@2x.png',
    '04-nav-a@2x.png',
    '04-nav-b@2x.png',
    '05-rest@2x.png',
  ]);
  let total = 0;
  for (const s of r.plan.strips) {
    const d = await decode(path.join(out, 'strips', s.file));
    assert.equal(d.info.width, s.pixels.width, s.file);
    assert.equal(d.info.height, s.pixels.height, s.file);
    if (s.letter !== 'b') total += d.info.height;
    const cmp = compareRegion(master.data, master.width, 3, d, s.pixels);
    assert.equal(cmp.differing, 0, `${s.file} must match the master exactly`);
  }
  assert.equal(total, 3000, 'strip heights add up to the full image');

  // the two columns: 400 and 800 pixels wide, side by side
  const a = r.plan.strips.find((s) => s.letter === 'a');
  const b = r.plan.strips.find((s) => s.letter === 'b');
  assert.deepEqual([a.pixels.left, a.pixels.width, b.pixels.left, b.pixels.width], [0, 400, 400, 800]);

  assert.equal(r.reassembly.pass, true);
  assert.equal(r.reassembly.png.identical, 6);
  assert.ok(log.lines.some((l) => l.startsWith('Reassembly check: PASS')));

  // every output file is there, and the manifest matches the files on disk
  for (const f of ['email.html', 'preview.html', 'blocks.md', 'manifest.json', 'check.png']) assert.ok(existsSync(path.join(out, f)), f);
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.strips.length, 6);
  assert.equal(manifest.scale, 2);
  assert.deepEqual(manifest.design, { width: 600, height: 1500 });
  for (const s of manifest.strips) {
    const buf = await fs.readFile(path.join(out, 'strips', s.file));
    assert.equal(buf.length, s.bytes);
    assert.equal(sha(buf), s.sha256);
  }
  assert.equal(manifest.source.sha256, sha(await fs.readFile(master.file)));

  // check.png is the 1x reassembly plus a numbered gutter
  const check = await sharp(path.join(out, 'check.png')).metadata();
  assert.deepEqual([check.width, check.height], [600 + 56, 1500]);
});

test('auto format: photo-like strips become JPG, flat strips stay PNG, JPGs stay within tolerance', async () => {
  const cuts = await writeCuts('auto-run', { format: 'auto', jpgQuality: 82, rows: syntheticRows() });
  const out = path.join(dir, 'out-auto');
  const r = await runCut({ master: master.file, cuts, out, log: collectLog() });
  const byName = Object.fromEntries(r.plan.strips.map((s) => [s.base, s]));
  assert.equal(byName['03-photo@2x'].format, 'jpg');
  assert.equal(byName['02-orange@2x'].format, 'png');
  assert.equal(byName['04-nav-a@2x'].format, 'png');
  for (const s of r.plan.strips) {
    const d = await decode(path.join(out, 'strips', s.file));
    const { mae, differing } = compareRegion(master.data, master.width, 3, d, s.pixels);
    if (s.format === 'png') assert.equal(differing, 0, s.file);
    else assert.ok(Math.max(...mae) < 3, `${s.file} average difference ${mae}`);
  }
  assert.equal(r.reassembly.pass, true);
  assert.ok(r.reassembly.jpg.count >= 1);
});

test('see-through areas are filled with the background colour, never black', async () => {
  const file = path.join(dir, 'transparent.png');
  const made = await makeSyntheticMaster(file, { alphaBand: [600, 800] });
  assert.equal((await sharp(file).metadata()).hasAlpha, true);
  for (const format of ['png', 'jpg']) {
    const cuts = await writeCuts(`alpha-${format}`, { format, background: '#123456', rows: syntheticRows() });
    const out = path.join(dir, `out-alpha-${format}`);
    const log = collectLog();
    const r = await runCut({ master: file, cuts, out, log });
    const band = r.plan.strips.find((s) => s.name === 'orange');
    const px = await pixelAt(path.join(out, 'strips', band.file), 600, 100);
    if (format === 'png') assert.deepEqual(px, [0x12, 0x34, 0x56]);
    else assert.ok(maxDiff(px, [0x12, 0x34, 0x56]) <= 3, `jpg got ${px}`);
    assert.ok(log.lines.some((l) => /See-through areas: found, filled with #123456/.test(l)));
    // the opaque parts are untouched
    const top = r.plan.strips[0];
    const k = (10 * made.width + 10) * 4;
    if (format === 'png') assert.deepEqual(await pixelAt(path.join(out, 'strips', top.file), 10, 10), [made.data[k], made.data[k + 1], made.data[k + 2]]);
  }
});

test('Display P3 PNG (as Paper exports it) is converted to sRGB, not just relabelled', async () => {
  // Stored numbers as Paper writes them: brand orange #FE8F50 is stored as 239,148,93 in Display P3.
  const stored = [
    [239, 148, 93],
    [128, 128, 128],
    [90, 160, 110],
  ];
  const raw = bandsRaw(1200, stored.map((c) => [400, c]));
  const untagged = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 3 } }).png().toBuffer();
  assert.equal((await sharp(untagged).metadata()).hasProfile, false);
  const tagged = addIccToPng(untagged, await displayP3Profile());
  const meta = await sharp(tagged).metadata();
  assert.equal(meta.hasProfile, true, 'the test master carries a P3 profile');
  const file = path.join(dir, 'p3-master.png');
  await fs.writeFile(file, tagged);

  const cuts = await writeCuts('p3-run', {
    format: 'png',
    rows: [
      { name: 'orange', to: 200, link: 'https://shop.example/', alt: 'Orange' },
      { name: 'grey', to: 400, link: 'https://shop.example/', alt: 'Grey' },
      { name: 'green', to: 'end', link: 'https://shop.example/', alt: 'Green' },
      { live: 'footer', address: ADDRESS },
    ],
  });
  const out = path.join(dir, 'out-p3');
  const log = collectLog();
  const r = await runCut({ master: file, cuts, out, log });
  assert.ok(log.lines.some((l) => /Colour: converted from ".*P3.*" to sRGB/.test(l)), log.lines.join('\n'));

  for (let i = 0; i < 3; i++) {
    const s = r.plan.strips[i];
    const got = await pixelAt(path.join(out, 'strips', s.file), 600, 200);
    const expected = p3ToSrgb(stored[i]);
    assert.ok(maxDiff(got, expected) <= 2, `${s.name}: got ${got}, correct sRGB is ${expected}`);
    const outMeta = await sharp(path.join(out, 'strips', s.file)).metadata();
    assert.equal(outMeta.hasProfile, false, 'strips carry no colour profile');
  }
  // the orange really is the brand orange, and it differs from a naive read of the stored numbers
  const orange = await pixelAt(path.join(out, 'strips', r.plan.strips[0].file), 600, 200);
  assert.ok(maxDiff(orange, [254, 143, 80]) <= 2, `orange came out as ${orange}`);
  assert.ok(maxDiff(orange, stored[0]) >= 10, 'a naive copy of the stored numbers would be visibly duller');
  const naive = await pixelAt(await sharp(tagged, { ignoreIcc: true }).png().toBuffer(), 600, 200);
  assert.deepEqual(naive, stored[0]);
});

test('Display P3 JPG is converted to sRGB too', async () => {
  const srgb = [254, 143, 80];
  const raw = bandsRaw(1200, [[400, srgb]]);
  const jpgP3 = await sharp(raw.data, { raw: { width: 1200, height: 400, channels: 3 } }).withIccProfile('p3').jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  const file = path.join(dir, 'p3-master.jpg');
  await fs.writeFile(file, jpgP3);
  const naive = await pixelAt(await sharp(jpgP3, { ignoreIcc: true }).png().toBuffer(), 600, 200);
  assert.ok(maxDiff(naive, srgb) >= 10, `stored P3 numbers ${naive} should differ from sRGB ${srgb}`);

  const cuts = await writeCuts('p3-jpg-run', { format: 'png', rows: [{ name: 'orange', to: 'end', link: 'https://shop.example/', alt: 'Orange' }, { live: 'footer', address: ADDRESS }] });
  const out = path.join(dir, 'out-p3-jpg');
  const r = await runCut({ master: file, cuts, out, log: collectLog() });
  const got = await pixelAt(path.join(out, 'strips', r.plan.strips[0].file), 600, 200);
  assert.ok(maxDiff(got, srgb) <= 3, `got ${got}, expected about ${srgb}`);
});

test('never overwrites an earlier export', async () => {
  const cuts = await writeCuts('overwrite', { format: 'png', rows: syntheticRows() });
  const out = path.join(dir, 'out-overwrite');
  await runCut({ master: master.file, cuts, out, log: collectLog() });
  const before = sha(await fs.readFile(path.join(out, 'email.html')));
  const stripsBefore = readdirSync(path.join(out, 'strips'));
  await assert.rejects(runCut({ master: master.file, cuts, out, log: collectLog() }), (e) => {
    assert.ok(e instanceof UserError);
    assert.match(e.message, /already exists\. cut-email never overwrites an earlier export.*out-overwrite-v2/);
    return true;
  });
  assert.equal(sha(await fs.readFile(path.join(out, 'email.html'))), before);
  assert.deepEqual(readdirSync(path.join(out, 'strips')), stripsBefore);
});

test('dry run checks and prints the plan but writes nothing', async () => {
  const cuts = await writeCuts('dry', { rows: syntheticRows() });
  const out = path.join(dir, 'out-dry');
  const listing = readdirSync(dir).sort();
  const log = collectLog();
  const r = await runCut({ master: master.file, cuts, out, dryRun: true, log });
  assert.equal(r.dryRun, true);
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(dir).sort(), listing);
  const text = log.lines.join('\n');
  assert.match(text, /dry run: nothing written/);
  assert.match(text, /04\s+row 4: nav, 800 to 900 in Paper, 1200 x 200 px, 2 columns \(200 \+ 400\)/);
  assert.match(text, /Settings check: PASS/);
  // a bad plan in dry run fails the same way and still writes nothing
  const bad = await writeCuts('dry-bad', { rows: [{ name: 'a', to: 1400, link: 'https://shop.example/', alt: 'A' }, { live: 'footer', address: ADDRESS }] });
  await assert.rejects(runCut({ master: master.file, cuts: bad, out, dryRun: true, log: collectLog() }), /bottom 100 would be lost/);
  assert.equal(existsSync(out), false);
});

test('a broken settings file fails before anything is written', async () => {
  const p = path.join(dir, 'broken.json');
  await fs.writeFile(p, '{ "rows": [ { "name": "a", "to": 100 }, ] }');
  const out = path.join(dir, 'out-broken');
  await assert.rejects(runCut({ master: master.file, cuts: p, out, log: collectLog() }), /broken.json is not valid JSON \(around line 1\): Unexpected token '\]'\. Common causes.*comma after the last row/s);
  const good = await writeCuts('missing-master', { rows: syntheticRows() });
  await assert.rejects(runCut({ master: path.join(dir, 'missing.png'), cuts: good, out, log: collectLog() }), /Cannot find the master image/);
  assert.equal(existsSync(out), false);
});

test('host: swaps in hosted links, never overwrites, and refuses bad link files', async () => {
  const cuts = await writeCuts('host', { format: 'png', rows: syntheticRows() });
  const out = path.join(dir, 'out-host');
  const r = await runCut({ master: master.file, cuts, out, log: collectLog() });
  const files = r.plan.strips.map((s) => s.file);
  const urls = files.map((f, i) => `https://cdn.example/email/${i + 1}-${f}`);
  const list = path.join(dir, 'links.txt');
  await fs.writeFile(list, urls.join('\n') + '\n');

  const first = await runHost({ out, urls: list, log: collectLog() });
  assert.equal(path.basename(first.file), 'email-hosted.html');
  const hosted = await fs.readFile(first.file, 'utf8');
  for (const u of urls) assert.ok(hosted.includes(`src="${u}"`), u);
  for (const f of files) assert.ok(!hosted.includes(`src="${f}"`), f);
  assert.ok(hosted.includes('[[unsubscribe_link]]'), 'the rest of the email is unchanged');

  const second = await runHost({ out, urls: list, log: collectLog() });
  assert.equal(path.basename(second.file), 'email-hosted-2.html');
  assert.equal(await fs.readFile(first.file, 'utf8'), hosted, 'the first hosted file is untouched');

  const json = path.join(dir, 'links.json');
  await fs.writeFile(json, JSON.stringify(Object.fromEntries(files.map((f, i) => [f, urls[i]]))));
  assert.equal(path.basename((await runHost({ out, urls: json, log: collectLog() })).file), 'email-hosted-3.html');

  const cases = {
    'short.txt': [urls.slice(1).join('\n'), /has 5 links, but this email has 6 strips/],
    'http.txt': [urls.map((u, i) => (i === 0 ? u.replace('https', 'http') : u)).join('\n'), /full https:\/\/ addresses/],
    'dupe.txt': [urls.map((u, i) => (i === 1 ? urls[0] : u)).join('\n'), /same link is given for 01-gradient@2x\.png and 02-orange@2x\.png/],
  };
  for (const [name, [content, pattern]] of Object.entries(cases)) {
    const p = path.join(dir, name);
    await fs.writeFile(p, content);
    await assert.rejects(runHost({ out, urls: p, log: collectLog() }), pattern);
  }
  assert.equal(existsSync(path.join(out, 'email-hosted-4.html')), false, 'failed runs write nothing');
  await assert.rejects(runHost({ out: dir, urls: list, log: collectLog() }), /not a cut-email output folder/);
});

test('the Oakline Home example cuts cleanly from a 2x master', async () => {
  const file = path.join(dir, 'oakline.png');
  await makeSyntheticMaster(file, { height: 7000 });
  const example = path.join(here, '..', 'example', 'cuts.example.json');
  const out = path.join(dir, 'out-oakline');
  const r = await runCut({ master: file, cuts: example, out, log: collectLog() });
  assert.equal(r.reassembly.pass, true);
  assert.equal(r.plan.strips.length, 13);
  const html = await fs.readFile(path.join(out, 'email.html'), 'utf8');
  assert.ok(html.includes('Code HELLO10 works once'));
  assert.ok(html.includes('[[unsubscribe_link]]') && html.includes('Surry Hills NSW 2010'));
});

test('command line: plain-English errors and exit codes', () => {
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  const help = run();
  assert.equal(help.status, 0);
  assert.match(help.stdout, /node cut-email\.mjs cut/);

  const badCuts = path.join(dir, 'cli-bad.json');
  return fs
    .writeFile(badCuts, JSON.stringify({ platform: 'omnisend', rows: [{ name: 'hero', to: 900, link: 'http://shop.example/' }, { name: 'b', to: 800, alt: 'B', link: 'https://shop.example/' }] }))
    .then(() => {
      const res = run('cut', master.file, badCuts, path.join(dir, 'out-cli'));
      assert.equal(res.status, 1);
      assert.match(res.stderr, /cut-email could not continue\. Nothing was written\./);
      assert.match(res.stderr, /1\. Row 1 \("hero"\)/);
      assert.match(res.stderr, /https:\/\//);
      assert.match(res.stderr, /must be bigger than the one before/);
      assert.ok(!/at .*\.mjs:\d+/.test(res.stderr), 'no stack trace for a settings problem');
      assert.equal(existsSync(path.join(dir, 'out-cli')), false);

      const goodCuts = path.join(dir, 'png-run.json');
      const dry = run('cut', master.file, goodCuts, path.join(dir, 'out-cli'), '--dry-run');
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /Settings check: PASS/);
      assert.equal(existsSync(path.join(dir, 'out-cli')), false);

      const unknown = run('cut', master.file, goodCuts, path.join(dir, 'out-cli'), '--force');
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /Unknown option --force/);
    });
});

test('colour profile names are read from both ICC description formats', async () => {
  const header = Buffer.alloc(128);
  const tagTable = (offset, size) => {
    const t = Buffer.alloc(16);
    t.writeUInt32BE(1, 0);
    t.write('desc', 4, 'latin1');
    t.writeUInt32BE(offset, 8);
    t.writeUInt32BE(size, 12);
    return t;
  };
  // version 4 profiles (Paper's exports): multi-language text, UTF-16
  const text = Buffer.from('Display P3 Gamut with sRGB Transfer', 'utf16le').swap16();
  const mluc = Buffer.alloc(28);
  mluc.write('mluc', 0, 'latin1');
  mluc.writeUInt32BE(1, 8);
  mluc.writeUInt32BE(12, 12);
  mluc.write('enUS', 16, 'latin1');
  mluc.writeUInt32BE(text.length, 20);
  mluc.writeUInt32BE(28, 24);
  const v4 = Buffer.concat([header, tagTable(144, 28 + text.length), mluc, text]);
  assert.equal(iccDescription(v4), 'Display P3 Gamut with sRGB Transfer');
  // version 2 profiles: plain ASCII
  const ascii = Buffer.from('sRGB IEC61966-2.1\0', 'latin1');
  const desc = Buffer.alloc(12);
  desc.write('desc', 0, 'latin1');
  desc.writeUInt32BE(ascii.length, 8);
  const v2 = Buffer.concat([header, tagTable(144, 12 + ascii.length), desc, ascii]);
  assert.equal(iccDescription(v2), 'sRGB IEC61966-2.1');
  assert.equal(iccDescription(Buffer.alloc(10)), null);
  // sharp's own Display P3 profile reads as a sensible name
  assert.match(iccDescription(await displayP3Profile()), /P3/);
});
