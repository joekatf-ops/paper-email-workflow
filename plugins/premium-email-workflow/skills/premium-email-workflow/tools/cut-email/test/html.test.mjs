// HTML, block list and hosted-link logic. No images needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, planCuts, buildEmailHtml, buildPreviewHtml, buildBlocksMd, parseUrlsFile, matchUrls, substituteUrls, UserError } from '../lib.mjs';

const ADDRESS = 'Test Pty Ltd, 1 Test Street, Sydney NSW 2000';

function makePlan(platform = 'omnisend', extraRows = null, extra = {}) {
  const rows = extraRows ?? [
    { name: 'logo', to: 100, link: 'https://shop.example/', alt: 'Shop "Name" & Co' },
    { name: 'hero', to: 600, link: 'https://shop.example/restore?items=[[items | url_encode]]&code=HELLO', alt: 'Hello. 10% off with HELLO10.' },
    { live: 'text', text: 'Use code HELLO10 <today>.', align: 'left' },
    { live: 'cart' },
    { name: 'nav', to: 700, columns: [{ width: 300, link: 'https://shop.example/a', alt: 'Shop all' }, { width: 300, link: 'https://shop.example/b', alt: 'Contact us' }] },
    { name: 'spacer', to: 'end', decorative: true },
    { live: 'footer', address: ADDRESS, note: 'You joined our list.' },
  ];
  const v = validateConfig({ name: 'welcome-1', platform, preheader: 'Your code is inside.', rows, ...extra });
  assert.deepEqual(v.errors, []);
  const p = planCuts(v.config, { width: 1200, height: 1600 });
  assert.deepEqual(p.errors, []);
  for (const s of p.plan.strips) s.file = `${s.base}.png`;
  return p.plan;
}

const files = (plan) => plan.strips.map((s) => s.file);

test('every strip sits in a zero-padding cell with its link, alt and width', () => {
  const plan = makePlan();
  const html = buildEmailHtml(plan);
  assert.equal((html.match(/<img /g) || []).length, plan.strips.length);
  // every image cell has zero padding, zero font size and zero line height
  const cells = html.match(/<td[^>]*>(?:<a [^>]*>)?<img /g);
  assert.equal(cells.length, plan.strips.length);
  for (const c of cells) assert.match(c, /padding:0;font-size:0;line-height:0;/);
  for (const s of plan.strips) {
    assert.ok(html.includes(`src="${s.file}"`), s.file);
    assert.match(html, new RegExp(`src="${s.file.replace('.', '\\.')}" width="${s.design.width}"`));
    assert.ok(html.includes(`max-width:${s.design.width}px`));
  }
  assert.ok(html.includes('alt="Shop &quot;Name&quot; &amp; Co"'), 'alt text is escaped');
  assert.ok(html.includes('alt="Hello. 10% off with HELLO10."'));
  assert.ok(html.includes('alt="Shop all"') && html.includes('alt="Contact us"'));
  assert.ok(html.includes('alt=""'), 'decorative strip has empty alt');
  assert.ok(html.includes('href="https://shop.example/a"') && html.includes('href="https://shop.example/b"'));
  // merge tags inside links are left alone, the & outside them is escaped
  assert.ok(html.includes('href="https://shop.example/restore?items=[[items | url_encode]]&amp;code=HELLO"'));
  assert.match(html, /display:block;width:100%;max-width:600px;height:auto;border:0/);
  assert.match(html, /<td width="50%" valign="top" style="padding:0;font-size:0;line-height:0;">/);
  assert.match(html, /role="presentation" align="center" width="600"/);
});

test('preheader is hidden text at the very top of the first block', () => {
  const html = buildEmailHtml(makePlan());
  const pre = html.indexOf('Your code is inside.');
  assert.ok(pre > 0);
  assert.ok(pre < html.indexOf('<table'), 'preheader comes before the first table');
  assert.match(html, /<div style="display:none;[^"]*mso-hide:all;">Your code is inside\./);
});

test('live inserts land in the right place', () => {
  const plan = makePlan();
  const html = buildEmailHtml(plan);
  const at = (needle) => {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  const hero = at('src="02-hero@2x.png"');
  const text = at('Use code HELLO10 &lt;today&gt;.');
  const cart = at('LIVE CART GOES HERE');
  const nav = at('src="03-nav-a@2x.png"');
  const footer = at('[[unsubscribe_link]]');
  assert.ok(hero < text && text < cart && cart < nav && nav < footer);
  assert.match(html, /<td align="left"[^>]*padding:24px 44px;font-family:Arial,Helvetica,sans-serif;font-size:16px;/);
});

test('a live cart without a file splits the email into two HTML blocks', () => {
  const html = buildEmailHtml(makePlan());
  assert.equal((html.match(/<table role="presentation" align="center"/g) || []).length, 2);
  assert.ok(html.includes('HTML BLOCK 1 of 2: START') && html.includes('HTML BLOCK 2 of 2: END'));
  assert.ok(html.includes('"Abandoned Products" item'));
  const k = buildEmailHtml(makePlan('klaviyo', null));
  assert.match(k, /Table block set to dynamic/);
  // HTML comments must never contain two dashes in a row
  for (const c of html.match(/<!--([\s\S]*?)-->/g)) assert.ok(!c.slice(4, -3).includes('--'), c);
});

test('a live cart from a file goes inline and keeps one HTML block', () => {
  const rows = [
    { name: 'hero', to: 600, link: 'https://shop.example/', alt: 'Hero' },
    { live: 'cart', file: 'loop.html' },
    { live: 'html', file: 'row.html' },
    { name: 'rest', to: 'end', link: 'https://shop.example/', alt: 'Rest' },
    { live: 'footer', address: ADDRESS },
  ];
  const plan = makePlan('omnisend', rows);
  const html = buildEmailHtml(plan, { snippets: { 'loop.html': '<table><tr><td>LOOP</td></tr></table>', 'row.html': '<tr><td>ROW</td></tr>' } });
  assert.equal((html.match(/<table role="presentation" align="center"/g) || []).length, 1);
  assert.ok(html.includes('<tr><td style="padding:0;"><table><tr><td>LOOP</td></tr></table></td></tr>'));
  assert.ok(html.includes('<tr><td>ROW</td></tr>') && !html.includes('<td style="padding:0;"><tr>'));
  assert.ok(html.indexOf('LOOP') < html.indexOf('ROW') && html.indexOf('ROW') < html.indexOf('src="02-rest@2x.png"'));
});

test('platform footers use the right live tags', () => {
  const o = buildEmailHtml(makePlan('omnisend'));
  assert.ok(o.includes('href="[[unsubscribe_link]]"') && o.includes('href="[[preference_link]]"') && o.includes(ADDRESS));
  assert.ok(o.includes('You joined our list.'));

  const k = buildEmailHtml(
    makePlan('klaviyo', [
      { name: 'hero', to: 'end', link: 'https://shop.example/', alt: 'Hero' },
      { live: 'footer' },
    ])
  );
  for (const tag of ['{% unsubscribe %}', '{% manage_preferences %}', '{{ organization.name }}', '{{ organization.full_address }}']) assert.ok(k.includes(tag), tag);
  assert.ok(!k.includes('[[unsubscribe_link]]'));

  const n = buildEmailHtml(makePlan('none'));
  assert.ok(n.includes('href="[UNSUBSCRIBE_LINK]"') && n.includes('href="[PREFERENCES_LINK]"') && n.includes(ADDRESS));
});

test('preview shows desktop and phone widths and loads local strips', () => {
  const plan = makePlan();
  const page = buildPreviewHtml(plan);
  assert.match(page, /^<!doctype html>/);
  assert.ok(page.includes('.desktop{width:600px}.phone{width:375px}'));
  assert.ok(page.includes('background:#EEF0F3'));
  for (const f of files(plan)) assert.equal(page.split(`src="strips/${f}"`).length - 1, 2, f);
  assert.ok(page.includes('Abandoned Products'), 'cart placeholder is visible in the preview');
  assert.ok(!page.includes('HTML BLOCK'), 'no paste instructions inside the preview');
});

test('blocks.md lists every block in order with zero padding', () => {
  const plan = makePlan();
  const md = buildBlocksMd(plan);
  const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l));
  assert.equal(rows.length, plan.items.length);
  assert.match(rows[0], /^\| 1 \| Image \| 01-logo@2x\.png \| https:\/\/shop\.example\/ \|/);
  assert.match(rows[2], /\| 3 \| Live text \|/);
  assert.match(rows[3], /\| 4 \| Live cart block \|.*Abandoned Products/);
  assert.match(rows[4], /\| 5 \| Two images side by side \| a: 03-nav-a@2x\.png<br>b: 03-nav-b@2x\.png/);
  assert.match(rows[6], /\| 7 \| Live footer \|/);
  assert.ok(rows.filter((r) => /Image|images side by side/.test(r)).every((r) => r.includes('padding 0 on all sides')));
  assert.ok(md.includes('[[items \\| url_encode]]'), 'pipes inside links are escaped for the table');
});

test('no generated output contains an em dash', () => {
  for (const platform of ['omnisend', 'klaviyo', 'none']) {
    const plan = makePlan(platform);
    for (const out of [buildEmailHtml(plan), buildPreviewHtml(plan), buildBlocksMd(plan)]) assert.ok(!out.includes('\u2014'));
  }
});

test('host: plain text links in strip order', () => {
  const plan = makePlan();
  const list = files(plan).map((f, i) => `https://cdn.example/img/${i + 1}.png`);
  const parsed = parseUrlsFile(`# uploaded 14 Oct\n\n${list.join('\n')}\n`);
  const m = matchUrls(files(plan), parsed);
  assert.deepEqual(m.errors, []);
  const out = substituteUrls(buildEmailHtml(plan), m.pairs);
  assert.deepEqual(out.errors, []);
  for (const u of list) assert.ok(out.html.includes(`src="${u}"`));
  for (const f of files(plan)) assert.ok(!out.html.includes(`src="${f}"`));
});

test('host: JSON map by file name', () => {
  const plan = makePlan();
  const map = Object.fromEntries(files(plan).map((f, i) => [f, `https://cdn.example/${i}.png`]));
  const m = matchUrls(files(plan), parseUrlsFile(JSON.stringify(map)));
  assert.deepEqual(m.errors, []);
  const missing = { ...map };
  delete missing[files(plan)[0]];
  missing['99-typo@2x.png'] = 'https://cdn.example/x.png';
  const bad = matchUrls(files(plan), parseUrlsFile(JSON.stringify(missing)));
  assert.ok(bad.errors.some((e) => /no link for: 01-logo@2x\.png/.test(e)));
  assert.ok(bad.errors.some((e) => /99-typo@2x\.png/.test(e)));
  assert.throws(() => parseUrlsFile('{ broken', { json: true }), UserError);
});

test('host: wrong count, http links and repeated links are refused', () => {
  const plan = makePlan();
  const fs_ = files(plan);
  const short = matchUrls(fs_, parseUrlsFile('https://cdn.example/1.png\nhttps://cdn.example/2.png'));
  assert.ok(short.errors[0].includes(`has 2 links, but this email has ${fs_.length} strips`));
  assert.ok(short.errors[0].includes(`1. ${fs_[0]}`));
  const insecure = matchUrls(fs_, parseUrlsFile(fs_.map((_, i) => (i === 1 ? 'http://cdn.example/1.png' : `https://cdn.example/${i}.png`)).join('\n')));
  assert.ok(insecure.errors.some((e) => /full https:\/\/ addresses/.test(e)));
  const dupe = matchUrls(fs_, parseUrlsFile(fs_.map((_, i) => `https://cdn.example/${i === 2 ? 1 : i}.png`).join('\n')));
  assert.ok(dupe.errors.some((e) => e.includes(`same link is given for ${fs_[1]} and ${fs_[2]}`)));
});
