#!/usr/bin/env node
// cut-email: cuts a tall Paper email export into linked image strips and builds paste-ready HTML.
//
//   node cut-email.mjs cut  <master-image> <cuts.json> <output-folder> [--dry-run]
//   node cut-email.mjs host <output-folder> <links-file>
//
// The README explains every step in plain English.

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {
  UserError,
  validateConfig,
  planCuts,
  checkCoverage,
  buildEmailHtml,
  buildPreviewHtml,
  buildBlocksMd,
  parseUrlsFile,
  matchUrls,
  substituteUrls,
  hexToRgb,
  escapeHtml,
  WARN_STRIP_BYTES,
  WARN_TOTAL_BYTES,
} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')).version;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const kb = (bytes) => `${Math.round(bytes / 1024).toLocaleString('en-AU')} KB`;
const JPG_TOLERANCE = 3;

// ---------- reading inputs ----------

async function readCuts(cutsPath) {
  let text;
  try {
    text = await fs.readFile(cutsPath, 'utf8');
  } catch {
    throw new UserError(`Cannot find the cuts file at "${cutsPath}". Check the file name and folder.`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    const msg = String(e.message);
    const lineOf = (index) => text.slice(0, index).split('\n').length;
    let line = null;
    const byLine = msg.match(/line (\d+)/);
    const byPos = msg.match(/position (\d+)/);
    const byToken = msg.match(/Unexpected token '(.)'/);
    if (byLine) line = Number(byLine[1]);
    else if (byPos) line = lineOf(Number(byPos[1]));
    else if (byToken && text.includes(byToken[1])) line = lineOf(text.indexOf(byToken[1]));
    const reason = msg.replace(/,\s*(\.\.\.)?".*" is not valid JSON$/s, '').replace(/ in JSON at position.*$/s, '');
    const curly = /[“”‘’]/.test(text) ? ' This file has curly quotes; replace them with straight quotes (").' : '';
    throw new UserError(
      `${path.basename(cutsPath)} is not valid JSON${line ? ` (around line ${line})` : ''}: ${reason}.${curly} Common causes: a missing comma between rows, a comma after the last row, or curly quotes instead of straight quotes.`
    );
  }
}

/** Reads the ICC profile's description, for example "Display P3". */
export function iccDescription(icc) {
  try {
    if (!icc || icc.length < 132) return null;
    const count = icc.readUInt32BE(128);
    for (let i = 0; i < count; i++) {
      const at = 132 + i * 12;
      if (icc.toString('latin1', at, at + 4) !== 'desc') continue;
      const off = icc.readUInt32BE(at + 4);
      const type = icc.toString('latin1', off, off + 4);
      if (type === 'desc') {
        const len = icc.readUInt32BE(off + 8);
        return icc.toString('latin1', off + 12, off + 12 + len).replace(/\0+$/, '').trim() || null;
      }
      if (type === 'mluc') {
        // mluc: 'mluc', 4 reserved bytes, record count, record size, then records of
        // language (2), country (2), string length (4), string offset (4). The first record is used.
        const strLen = icc.readUInt32BE(off + 20);
        const strOff = icc.readUInt32BE(off + 24);
        const raw = icc.subarray(off + strOff, off + strOff + strLen);
        let s = '';
        for (let j = 0; j + 1 < raw.length; j += 2) s += String.fromCharCode(raw.readUInt16BE(j));
        return s.replace(/\0+$/, '').trim() || null;
      }
    }
  } catch {
    /* an unreadable description is not a problem */
  }
  return null;
}

async function readMaster(masterPath) {
  if (!existsSync(masterPath)) throw new UserError(`Cannot find the master image at "${masterPath}". Check the file name and folder.`);
  let meta;
  try {
    meta = await sharp(masterPath).metadata();
  } catch {
    throw new UserError(`"${path.basename(masterPath)}" is not an image cut-email can open. Export the artboard from Paper as PNG or JPG.`);
  }
  if (!['png', 'jpeg', 'webp'].includes(meta.format))
    throw new UserError(`"${path.basename(masterPath)}" is a ${meta.format} file. Export the artboard from Paper as PNG or JPG.`);
  const orientation = meta.orientation && meta.orientation > 4;
  const width = orientation ? meta.height : meta.width;
  const height = orientation ? meta.width : meta.height;
  return { meta, width, height };
}

async function loadSnippets(config, cutsDir) {
  const snippets = {};
  const errors = [];
  const warnings = [];
  for (const row of config.rows) {
    if (row.type !== 'live' || !row.file) continue;
    const p = path.resolve(cutsDir, row.file);
    try {
      const text = await fs.readFile(p, 'utf8');
      if (!text.trim()) errors.push(`Row ${row.row} (live ${row.live}): "${row.file}" is empty.`);
      if (/<(html|body)[\s>]/i.test(text))
        warnings.push(`Row ${row.row} (live ${row.live}): "${row.file}" looks like a whole web page. Keep only the part that goes inside the email (no <html> or <body> tags).`);
      snippets[row.file] = text;
    } catch {
      errors.push(`Row ${row.row} (live ${row.live}): cannot find "${row.file}". Put it in the same folder as cuts.json (${cutsDir}), or fix the name.`);
    }
  }
  return { snippets, errors, warnings };
}

// ---------- image work ----------

/**
 * Decodes the master into plain sRGB pixels with no see-through areas.
 * 1. The embedded colour profile (Paper exports Display P3) is converted to sRGB. Without this, colours go dull.
 * 2. Transparent areas are filled with the background colour. Without this, they turn black in JPG.
 */
export async function decodeMaster(masterPath, background) {
  const meta = await sharp(masterPath).metadata();
  let hadTransparency = false;
  if (meta.hasAlpha) {
    const stats = await sharp(masterPath).stats();
    hadTransparency = stats.channels[stats.channels.length - 1].min < 255;
  }
  const { data, info } = await sharp(masterPath)
    .rotate()
    .flatten({ background: hexToRgb(background) })
    .toColourspace('srgb')
    .removeAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Expected 3 colour channels after conversion, got ${info.channels}`);
  return {
    data,
    width: info.width,
    height: info.height,
    hadTransparency,
    profile: meta.icc ? iccDescription(meta.icc) ?? 'an embedded colour profile' : null,
  };
}

async function encodeStrip(master, px, format, jpgQuality) {
  const piece = () =>
    sharp(master.data, { raw: { width: master.width, height: master.height, channels: 3 } }).extract({
      left: px.left,
      top: px.top,
      width: px.width,
      height: px.height,
    });
  // Output never carries a colour profile: the pixels are already sRGB, which is what email clients assume.
  const png = () => piece().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const jpg = () => piece().jpeg({ quality: jpgQuality, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
  if (format === 'png') return { buffer: await png(), format: 'png', reason: 'set to png' };
  if (format === 'jpg') return { buffer: await jpg(), format: 'jpg', reason: 'set to jpg' };
  const [p, j] = await Promise.all([png(), jpg()]);
  return j.length < p.length
    ? { buffer: j, format: 'jpg', reason: `auto: JPG ${kb(j.length)} beat PNG ${kb(p.length)} (photo-like)` }
    : { buffer: p, format: 'png', reason: `auto: PNG ${kb(p.length)} beat JPG ${kb(j.length)} (flat graphic)` };
}

/** Rebuilds the email from the strip files on disk and compares it with the converted master. */
export async function reassemble(master, plan, stripDir) {
  const canvas = Buffer.from(master.data);
  const W = master.width;
  const details = [];
  for (const s of plan.strips) {
    const { data, info } = await sharp(path.join(stripDir, s.file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = s.pixels;
    if (info.width !== px.width || info.height !== px.height) {
      details.push({ file: s.file, format: s.format, pass: false, problem: `is ${info.width} x ${info.height}, expected ${px.width} x ${px.height}` });
      continue;
    }
    const sums = [0, 0, 0];
    let differentBytes = 0;
    for (let y = 0; y < px.height; y++) {
      const rowStart = ((px.top + y) * W + px.left) * 3;
      for (let x = 0; x < px.width * 3; x++) {
        const a = master.data[rowStart + x];
        const b = data[y * px.width * 3 + x];
        const d = a > b ? a - b : b - a;
        if (d) differentBytes++;
        sums[x % 3] += d;
        canvas[rowStart + x] = b;
      }
    }
    const n = px.width * px.height;
    const mae = sums.map((v) => +(v / n).toFixed(3));
    const pass = s.format === 'png' ? differentBytes === 0 : Math.max(...mae) < JPG_TOLERANCE;
    details.push({ file: s.file, format: s.format, pass, identical: differentBytes === 0, meanAbsError: mae });
  }
  const coverage = checkCoverage(plan);
  const pngs = details.filter((d) => d.format === 'png');
  const jpgs = details.filter((d) => d.format === 'jpg');
  return {
    canvas,
    result: {
      pass: coverage.length === 0 && details.every((d) => d.pass),
      coverageProblems: coverage,
      png: { count: pngs.length, identical: pngs.filter((d) => d.identical).length },
      jpg: { count: jpgs.length, worstMeanAbsError: jpgs.length ? Math.max(...jpgs.flatMap((d) => d.meanAbsError)) : 0, tolerance: JPG_TOLERANCE },
      details,
    },
  };
}

async function writeCheckImage(canvas, master, plan, outPath) {
  const dw = plan.designWidth;
  const dh = Math.round(plan.height / plan.scale);
  const gutter = 56;
  const base = await sharp(canvas, { raw: { width: master.width, height: master.height, channels: 3 } })
    .resize({ width: dw, height: dh, fit: 'fill' })
    .extend({ right: gutter, background: '#FFFFFF' })
    .png()
    .toBuffer();
  const shapes = [];
  let band = 0;
  for (const item of plan.items) {
    if (item.type === 'live') {
      if (!item.replaces) continue;
      const { top, height } = item.replaces.design;
      const label = `Replaced by live ${item.live}`;
      shapes.push(
        `<rect x="0" y="${top}" width="${dw}" height="${height}" fill="#E91E63" fill-opacity="0.28"/>`,
        `<rect x="8" y="${top + 8}" width="${label.length * 9 + 24}" height="28" rx="6" fill="#FFFFFF" stroke="#C2185B" stroke-width="2"/>`,
        `<text x="20" y="${top + 27}" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700" fill="#7A1240">${escapeHtml(label)}</text>`
      );
      continue;
    }
    const { top, height } = item.design;
    shapes.push(
      `<rect x="${dw}" y="${top}" width="${gutter}" height="${height}" fill="${band++ % 2 ? '#D5D9E0' : '#EEF0F3'}"/>`,
      `<text x="${dw + gutter / 2}" y="${top + Math.min(height / 2, 24) + 5}" font-family="Helvetica, Arial, sans-serif" font-size="14" font-weight="700" fill="#333333" text-anchor="middle">${String(item.number).padStart(2, '0')}</text>`
    );
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${dw + gutter}" height="${dh}">${shapes.join('')}</svg>`);
  await sharp(base).composite([{ input: svg, top: 0, left: 0 }]).png({ compressionLevel: 9 }).toFile(outPath);
}

async function writeNew(p, data) {
  // flag "wx" refuses to replace a file that is already there.
  await fs.writeFile(p, data, { flag: 'wx' });
}

// ---------- the cut command ----------

/**
 * Runs the whole cut. Throws UserError for anything the person can fix.
 * Returns a summary object (also used by the tests).
 */
export async function runCut({ master: masterArg, cuts: cutsArg, out: outArg, dryRun = false, log = console.log }) {
  if (!masterArg || !cutsArg || (!outArg && !dryRun))
    throw new UserError('Usage: node cut-email.mjs cut <master-image> <cuts.json> <output-folder> [--dry-run]');
  const masterPath = path.resolve(masterArg);
  const cutsPath = path.resolve(cutsArg);
  const outDir = outArg ? path.resolve(outArg) : null;

  const raw = await readCuts(cutsPath);
  const checked = validateConfig(raw);
  if (!checked.config?.name && checked.config) checked.config.name = path.basename(cutsPath).replace(/\.json$/i, '');
  const errors = [...checked.errors];
  const warnings = [...checked.warnings];
  let meta = null;
  let width = 0;
  let height = 0;
  try {
    ({ meta, width, height } = await readMaster(masterPath));
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    errors.push(...e.problems);
  }
  let plan = null;
  if (!errors.length) {
    const planned = planCuts(checked.config, { width, height });
    errors.push(...planned.errors);
    warnings.push(...planned.warnings);
    plan = planned.plan;
  }
  let snippets = {};
  if (checked.config?.rows) {
    const loaded = await loadSnippets(checked.config, path.dirname(cutsPath));
    errors.push(...loaded.errors);
    warnings.push(...loaded.warnings);
    snippets = loaded.snippets;
  }
  if (outDir && existsSync(outDir))
    errors.push(`The output folder "${outDir}" already exists. cut-email never overwrites an earlier export. Choose a new folder name, for example "${path.basename(outDir)}-v2".`);
  if (errors.length) throw new UserError(errors);

  const header = `cut-email ${VERSION}: "${plan.name}" for ${plan.platform === 'none' ? 'no platform' : plan.platform}`;
  const sizeLine = `Master: ${path.basename(masterPath)} (${meta.format}, ${width} x ${height} pixels = ${plan.designWidth} x ${plan.designHeight} in Paper at ${plan.scale}x)`;

  if (dryRun) {
    log(header + ' (dry run: nothing written)');
    log(sizeLine);
    log('');
    log(describePlan(plan));
    printWarnings(warnings, log);
    log('');
    log('Settings check: PASS. Run again without --dry-run to cut.');
    return { dryRun: true, plan, warnings };
  }

  // Decode first, so a broken image never leaves a half-made folder behind.
  const master = await decodeMaster(masterPath, plan.background);
  if (master.width !== width || master.height !== height) throw new Error('Decoded size does not match the image header.');

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(outDir); // fails if it exists: never overwrite an earlier export
  const stripDir = path.join(outDir, 'strips');
  await fs.mkdir(stripDir);

  let total = 0;
  for (const s of plan.strips) {
    const enc = await encodeStrip(master, s.pixels, s.format, plan.jpgQuality);
    s.format = enc.format;
    s.formatReason = enc.reason;
    s.file = `${s.base}.${enc.format}`;
    s.bytes = enc.buffer.length;
    s.sha256 = sha256(enc.buffer);
    total += s.bytes;
    if (s.bytes > WARN_STRIP_BYTES)
      warnings.push(`${s.file} is ${kb(s.bytes)}. Klaviyo recommends 1 MB or less per image. Try a lower "jpgQuality", or add a cut.`);
    await writeNew(path.join(stripDir, s.file), enc.buffer);
  }
  if (total > WARN_TOTAL_BYTES)
    warnings.push(`All strips together are ${kb(total)}. Over 3 MB loads slowly on phones. Try a lower "jpgQuality" or simpler imagery.`);

  await writeNew(path.join(outDir, 'email.html'), buildEmailHtml(plan, { snippets }));
  await writeNew(path.join(outDir, 'preview.html'), buildPreviewHtml(plan, { snippets }));
  await writeNew(path.join(outDir, 'blocks.md'), buildBlocksMd(plan));

  const { canvas, result } = await reassemble(master, plan, stripDir);
  await writeCheckImage(canvas, master, plan, path.join(outDir, 'check.png'));

  const masterBytes = await fs.readFile(masterPath);
  const manifest = {
    tool: 'cut-email',
    toolVersion: VERSION,
    created: new Date().toISOString(),
    name: plan.name,
    platform: plan.platform,
    source: {
      file: path.basename(masterPath),
      sha256: sha256(masterBytes),
      format: meta.format,
      width,
      height,
      colourProfile: master.profile,
      convertedToSrgb: true,
      hadTransparency: master.hadTransparency,
      flattenedOnto: plan.background,
    },
    cuts: { file: path.basename(cutsPath), sha256: sha256(await fs.readFile(cutsPath)) },
    design: { width: plan.designWidth, height: plan.designHeight },
    scale: plan.scale,
    rows: plan.items.map((item) =>
      item.type === 'live'
        ? { row: item.row, type: `live ${item.live}`, file: item.file ?? null, replacesDesign: item.replaces?.design ?? null, replacesPixels: item.replaces?.pixels ?? null }
        : { row: item.row, type: item.type, strip: item.number, files: item.type === 'image' ? [item.strip.file] : item.cells.map((c) => c.file) }
    ),
    strips: plan.strips.map((s) => ({
      number: s.number,
      column: s.letter,
      name: s.name,
      file: s.file,
      format: s.format,
      formatReason: s.formatReason,
      pixels: s.pixels,
      design: s.design,
      bytes: s.bytes,
      sha256: s.sha256,
      link: s.link,
      alt: s.alt,
      decorative: s.decorative,
    })),
    totals: { strips: plan.strips.length, bytes: total },
    reassembly: result,
    warnings,
  };
  await writeNew(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // ---------- report ----------
  const jpgs = plan.strips.filter((s) => s.format === 'jpg').length;
  log(header);
  log(sizeLine);
  log(master.profile ? `Colour: converted from "${master.profile}" to sRGB, profile removed from the strips.` : 'Colour: no colour profile in the master, read as sRGB.');
  log(master.hadTransparency ? `See-through areas: found, filled with ${plan.background}.` : 'See-through areas: none.');
  log(`Strips: ${plan.strips.length} files, ${kb(total)} total (${jpgs} JPG, ${plan.strips.length - jpgs} PNG).`);
  log(reassemblyLine(result));
  printWarnings(warnings, log);
  log('');
  log(`Wrote to ${outDir}: strips/ (${plan.strips.length} files), email.html, preview.html, blocks.md, manifest.json, check.png`);
  log('Next: open preview.html and check.png to check it. Then upload the strips and run the host command.');
  if (!result.pass) {
    throw new UserError(
      [
        'The reassembly check failed: the strips do not rebuild the master exactly. Do not send this email. Details are in manifest.json under "reassembly".',
        ...result.coverageProblems,
        ...result.details.filter((d) => !d.pass).map((d) => `${d.file}: ${d.problem ?? `average difference ${Math.max(...d.meanAbsError)}`}`),
      ],
      'cut-email finished, but the check failed.'
    );
  }
  return { dryRun: false, plan, manifest, warnings, reassembly: result, totalBytes: total, outDir };
}

function reassemblyLine(r) {
  if (!r.pass) return 'Reassembly check: FAIL. See manifest.json.';
  const parts = [];
  if (r.png.count) parts.push(`${r.png.identical} of ${r.png.count} PNG strips identical to the master`);
  if (r.jpg.count) parts.push(`${r.jpg.count} JPG strips within tolerance (worst average difference ${r.jpg.worstMeanAbsError} of 255, limit ${r.jpg.tolerance})`);
  return `Reassembly check: PASS. No gaps, no overlaps; ${parts.join('; ')}.`;
}

function describePlan(plan) {
  const lines = [];
  for (const item of plan.items) {
    if (item.type === 'live') {
      const r = item.replaces ? ` replaces ${item.replaces.design.top} to ${item.replaces.design.top + item.replaces.design.height} in Paper` : '';
      lines.push(`  --  row ${item.row}: live ${item.live}${item.file ? ` from ${item.file}` : ''}${r}`);
      continue;
    }
    const n = String(item.number).padStart(2, '0');
    const d = item.design;
    const size = `${plan.width} x ${item.pixels.height} px`;
    if (item.type === 'image') lines.push(`  ${n}  row ${item.row}: ${item.name}, ${d.top} to ${d.top + d.height} in Paper, ${size}, link ${item.strip.link ?? 'none (decorative)'}`);
    else lines.push(`  ${n}  row ${item.row}: ${item.name}, ${d.top} to ${d.top + d.height} in Paper, ${size}, ${item.cells.length} columns (${item.cells.map((c) => c.design.width).join(' + ')})`);
  }
  return `Plan: ${plan.strips.length} strip files\n${lines.join('\n')}`;
}

function printWarnings(warnings, log) {
  if (!warnings.length) return;
  log('');
  log('Worth a look (these do not stop the cut):');
  warnings.forEach((w, i) => log(`  ${i + 1}. ${w}`));
}

// ---------- the host command ----------

export async function runHost({ out: outArg, urls: urlsArg, log = console.log }) {
  if (!outArg || !urlsArg) throw new UserError('Usage: node cut-email.mjs host <output-folder> <links-file>');
  const outDir = path.resolve(outArg);
  const heading = 'cut-email could not swap in the hosted links. Nothing was written.';
  let manifest;
  let html;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'));
    html = await fs.readFile(path.join(outDir, 'email.html'), 'utf8');
  } catch {
    throw new UserError(`"${outDir}" is not a cut-email output folder (manifest.json or email.html is missing). Point the host command at the folder the cut command made.`, heading);
  }
  let text;
  try {
    text = await fs.readFile(path.resolve(urlsArg), 'utf8');
  } catch {
    throw new UserError(`Cannot find the links file at "${urlsArg}".`, heading);
  }
  const parsed = parseUrlsFile(text, { json: /\.json$/i.test(urlsArg) ? true : undefined });
  const files = manifest.strips.map((s) => s.file);
  const matched = matchUrls(files, parsed);
  if (matched.errors.length) throw new UserError(matched.errors, heading);
  const swapped = substituteUrls(html, matched.pairs);
  if (swapped.errors.length) throw new UserError(swapped.errors, heading);

  let name = 'email-hosted.html';
  for (let n = 2; existsSync(path.join(outDir, name)); n++) name = `email-hosted-${n}.html`;
  await writeNew(path.join(outDir, name), swapped.html);
  log(`Wrote ${name} with ${matched.pairs.length} hosted image links. Paste it into your email platform's custom HTML block.`);
  return { file: path.join(outDir, name), pairs: matched.pairs };
}

// ---------- command line ----------

const HELP = `cut-email ${VERSION}

  node cut-email.mjs cut  <master-image> <cuts.json> <output-folder> [--dry-run]
      Cuts a 2x Paper export into strips and writes email.html, preview.html,
      blocks.md, manifest.json and check.png into a NEW output folder.
      --dry-run checks the settings and prints the plan without writing anything.

  node cut-email.mjs host <output-folder> <links-file>
      Swaps the strip file names in email.html for your uploaded image links
      and writes email-hosted.html. The links file is one https link per line,
      in strip order, or JSON: { "01-hero@2x.jpg": "https://..." }.
`;

export async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [command, ...rest] = args;
  const known = new Set(['--dry-run', '--help']);
  const unknown = [...flags].filter((f) => !known.has(f));
  try {
    if (unknown.length) throw new UserError(`Unknown option ${unknown.join(', ')}. The only option is --dry-run.`);
    if (!command || command === 'help' || flags.has('--help')) {
      console.log(HELP);
      return 0;
    }
    if (command === 'cut') await runCut({ master: rest[0], cuts: rest[1], out: rest[2], dryRun: flags.has('--dry-run') });
    else if (command === 'host') await runHost({ out: rest[0], urls: rest[1] });
    else throw new UserError(`Unknown command "${command}". Use "cut" or "host".\n\n${HELP}`);
    return 0;
  } catch (e) {
    if (e instanceof UserError) {
      console.error('');
      console.error(e.heading);
      console.error('');
      e.problems.forEach((p, i) => console.error(e.problems.length > 1 ? `  ${i + 1}. ${p}` : `  ${p}`));
      console.error('');
      return 1;
    }
    console.error('');
    console.error('Something unexpected went wrong inside cut-email. This is not a settings problem.');
    console.error(String(e?.stack || e));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
