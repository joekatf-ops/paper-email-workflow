// Settings checks and cut planning. No images needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, planCuts, checkCoverage, linkProblem, MAX_STRIP_PX } from '../lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const footer = { live: 'footer', address: 'Test Pty Ltd, 1 Test Street, Sydney NSW 2000' };
const cfg = (rows, extra = {}) => ({ name: 't', platform: 'omnisend', rows, ...extra });
const img = (name, to, more = {}) => ({ name, to, link: 'https://shop.example/x', alt: `${name} words`, ...more });

function plan(rows, size = { width: 1200, height: 3000 }, extra = {}) {
  const v = validateConfig(cfg(rows, extra));
  assert.deepEqual(v.errors, [], 'settings should pass');
  return planCuts(v.config, size);
}

const hasError = (errors, pattern) => assert.ok(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got:\n${errors.join('\n')}`);

test('a correct plan passes with no errors', () => {
  const v = validateConfig(cfg([img('a', 500), img('b', 1000), img('c', 'end'), footer]));
  assert.deepEqual(v.errors, []);
  const p = planCuts(v.config, { width: 1200, height: 3000 });
  assert.deepEqual(p.errors, []);
});

test('error: "to" values that do not increase', () => {
  const v = validateConfig(cfg([img('a', 500), img('b', 400), img('c', 'end'), footer]));
  hasError(v.errors, /Row 2 \("b"\) ends at 400, but Row 1 \("a"\) already ends at 500/);
  const same = validateConfig(cfg([img('a', 500), img('b', 500), footer]));
  hasError(same.errors, /must be bigger than the one before/);
});

test('error: "end" used before the last cut', () => {
  const v = validateConfig(cfg([img('a', 'end'), img('b', 900), footer]));
  hasError(v.errors, /Only the last cut can use "end"/);
});

test('error: last cut does not reach the bottom of the image', () => {
  const p = plan([img('a', 500), img('b', 1400), footer]);
  hasError(p.errors, /last cut ends at 1400, but the image is 1500 tall in Paper, so the bottom 100 would be lost/);
});

test('error: a cut past the bottom of the image', () => {
  const p = plan([img('a', 900), img('b', 1600), footer]);
  hasError(p.errors, /ends at 1600, but the image is only 1500 tall/);
});

test('error: column widths that do not add up to the design width', () => {
  const v = validateConfig(
    cfg([
      { name: 'nav', to: 100, columns: [{ width: 300, link: 'https://shop.example/a', alt: 'A' }, { width: 250, link: 'https://shop.example/b', alt: 'B' }] },
      img('rest', 'end'),
      footer,
    ])
  );
  hasError(v.errors, /column widths add up to 550, but the email is 600 wide/);
});

test('error: missing alt text, unless the strip is decorative', () => {
  const v = validateConfig(cfg([{ name: 'hero', to: 500, link: 'https://shop.example/' }, { name: 'gap', to: 'end', decorative: true }, footer]));
  hasError(v.errors, /Row 1 \("hero"\) has no "alt" text/);
  assert.equal(v.errors.length, 1, 'the decorative row needs no alt or link');
});

test('error: missing link on a strip that is not decorative', () => {
  const v = validateConfig(cfg([{ name: 'hero', to: 'end', alt: 'Hello' }, footer]));
  hasError(v.errors, /has no "link"/);
});

test('error: http links are refused, https and merge tags are accepted', () => {
  const v = validateConfig(cfg([img('a', 'end', { link: 'http://shop.example/' }), footer]));
  hasError(v.errors, /starts with http:\/\/\. Use the secure https:\/\/ version/);
  for (const ok of [
    'https://shop.example/products/x',
    'https://shop.example/pages/restore?items=[[items | url_encode]]&code=A',
    '{{ event.extra.checkout_url }}',
    '{% url %}',
    '[[event.raw.abandoned_checkout_url]]',
    'mailto:hello@shop.example',
  ])
    assert.equal(linkProblem(ok), null, ok);
  for (const bad of ['shop.example/x', 'https://shop.example/a b', 'ftp://shop.example', '', 'https://localhost', '{{ x|default:"y" }}'])
    assert.notEqual(linkProblem(bad), null, bad);
});

test('error: the image width is not a whole multiple of the design width', () => {
  const v = validateConfig(cfg([img('a', 'end'), footer]));
  const p = planCuts(v.config, { width: 1250, height: 3000 });
  hasError(p.errors, /1250 pixels wide.*scale of 2.083, which is not a whole number/);
  assert.equal(p.plan, null);
});

test('error: a strip 2000 pixels or taller, unless allowTall is set', () => {
  const p = plan([img('a', 1000), img('b', 'end'), footer]);
  hasError(p.errors, /Row 1 \("a"\) is 1000 pixels tall in Paper \(2000 pixels in the file\).*Add a cut/);
  hasError(p.errors, /for example one ending at 500/);
  const allowed = plan([img('a', 1000, { allowTall: true }), img('b', 'end'), footer]);
  assert.deepEqual(allowed.errors, []);
  assert.ok(allowed.warnings.some((w) => /Omnisend will reject/.test(w)));
  const justUnder = plan([img('a', 999.5), img('b', 'end'), footer]);
  assert.deepEqual(justUnder.errors, []);
  assert.equal(justUnder.plan.strips[0].pixels.height, MAX_STRIP_PX - 1);
});

test('warning: very long single image over 1600 in Paper', () => {
  const p = plan([img('a', 1700, { allowTall: true }), img('b', 'end'), footer], { width: 1200, height: 4000 });
  assert.ok(p.warnings.some((w) => /1700 pixels tall in Paper. Long single images load slowly/.test(w)));
});

test('error: unknown settings get a suggestion', () => {
  const v = validateConfig(cfg([{ name: 'a', to: 'end', lnk: 'https://shop.example/', alt: 'A' }, footer]));
  hasError(v.errors, /setting called "lnk".*Did you mean "link"\?/);
  const notes = validateConfig(cfg([img('a', 'end', { _note: 'ignored', comment: 'also ignored' }), footer]));
  assert.deepEqual(notes.errors, []);
});

test('error: live rows need their own settings', () => {
  const v = validateConfig(cfg([img('a', 'end'), { live: 'html' }, { live: 'text' }, { live: 'banner' }, { live: 'footer' }]));
  hasError(v.errors, /needs a "file"/);
  hasError(v.errors, /needs "text"/);
  hasError(v.errors, /"live" is "banner"/);
  hasError(v.errors, /needs "address"/);
  const k = validateConfig(cfg([img('a', 'end'), { live: 'footer', address: 'X' }], { platform: 'klaviyo' }));
  assert.deepEqual(k.errors, []);
  assert.ok(k.warnings.some((w) => /Klaviyo fills in your business name and address/.test(w)));
});

test('error: wrong types are explained plainly', () => {
  const v = validateConfig({ rows: [img('a', '900'), footer], platform: 'mailchimp', background: 'white', jpgQuality: 120, format: 'webp' });
  hasError(v.errors, /"to" is "900".*as a number without quotes/);
  hasError(v.errors, /"platform" is "mailchimp"/);
  hasError(v.errors, /"background" is "white"/);
  hasError(v.errors, /"jpgQuality" is 120/);
  hasError(v.errors, /"format" is "webp"/);
  hasError(validateConfig([]).errors, /starts with \{ and ends with \}/);
  hasError(validateConfig({}).errors, /no "rows" list/);
});

test('planning: design pixels become exact file pixels at 2x', () => {
  const { plan: p, errors } = plan([
    img('logo', 100),
    { name: 'Footer Nav', to: 150, columns: [{ width: 200, link: 'https://shop.example/a', alt: 'A' }, { width: 400, link: 'https://shop.example/b', alt: 'B' }] },
    { live: 'cart', to: 400 },
    img('body', 1200.5),
    { live: 'text', text: 'Hello' },
    img('end', 'end', { decorative: true }),
    footer,
  ]);
  assert.deepEqual(errors, []);
  assert.equal(p.scale, 2);
  assert.equal(p.designHeight, 1500);
  assert.deepEqual(
    p.strips.map((s) => [s.base, s.pixels.left, s.pixels.top, s.pixels.width, s.pixels.height]),
    [
      ['01-logo@2x', 0, 0, 1200, 200],
      ['02-footer-nav-a@2x', 0, 200, 400, 100],
      ['02-footer-nav-b@2x', 400, 200, 800, 100],
      ['03-body@2x', 0, 800, 1200, 1601],
      ['04-end@2x', 0, 2401, 1200, 599],
    ]
  );
  const cart = p.items.find((i) => i.live === 'cart');
  assert.deepEqual(cart.replaces.pixels, { left: 0, top: 300, width: 1200, height: 500 });
  assert.deepEqual(cart.replaces.design, { left: 0, top: 150, width: 600, height: 250 });
  assert.equal(p.strips[2].design.left, 200);
  assert.equal(p.strips[2].design.width, 400);
  assert.equal(p.strips[4].alt, '', 'decorative strips get empty alt text');
  assert.deepEqual(checkCoverage(p), []);
  // heights plus the replaced area add up to the full image
  const rows = new Set();
  let sum = cart.replaces.pixels.height;
  for (const s of p.strips) if (!rows.has(s.number)) (rows.add(s.number), (sum += s.pixels.height));
  assert.equal(sum, 3000);
});

test('planning: half pixel positions work at 2x but not at 1x, and 3x works', () => {
  const ok = plan([img('a', 100.5), img('b', 'end'), footer]);
  assert.equal(ok.plan.strips[0].pixels.height, 201);
  const v = validateConfig(cfg([img('a', 100.5), img('b', 'end'), footer]));
  const at1x = planCuts(v.config, { width: 600, height: 1500 });
  hasError(at1x.errors, /not a whole pixel row/);
  assert.ok(at1x.warnings.some((w) => /1x/.test(w)));
  const v3 = validateConfig(cfg([img('a', 300), img('b', 'end'), footer]));
  const at3x = planCuts(v3.config, { width: 1800, height: 1800 });
  assert.deepEqual(at3x.errors, []);
  assert.equal(at3x.plan.scale, 3);
  assert.equal(at3x.plan.strips[0].base, '01-a@3x');
  assert.equal(at3x.plan.strips[0].pixels.height, 900);
});

test('coverage check catches a gap or overlap', () => {
  const { plan: p } = plan([img('a', 500), img('b', 'end'), footer]);
  p.items[1].pixels.top += 2;
  assert.ok(checkCoverage(p).some((e) => /gap/.test(e)));
  p.items[1].pixels.top -= 4;
  assert.ok(checkCoverage(p).some((e) => /overlap/.test(e)));
});

test('the Oakline Home example passes the settings check', () => {
  const example = JSON.parse(fs.readFileSync(path.join(here, '..', 'example', 'cuts.example.json'), 'utf8'));
  const v = validateConfig(example);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  const imageRows = v.config.rows.filter((r) => r.type !== 'live');
  assert.equal(imageRows.length, 9);
  assert.ok(v.config.rows.some((r) => r.type === 'columns' && r.cells.length === 2));
  assert.ok(v.config.rows.some((r) => r.live === 'footer'));
  const p = planCuts(v.config, { width: 1200, height: 7000 });
  assert.deepEqual(p.errors, []);
});
