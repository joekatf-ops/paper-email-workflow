// Pure functions for cut-email: settings checks, cut planning, HTML and block list building,
// and hosted-link matching. Nothing in this file reads or writes images or files, so it can be
// tested without any pictures.

import { platforms, platformNames, footerHtml } from './snippets.mjs';

export const DEFAULTS = Object.freeze({
  designWidth: 600,
  background: '#FFFFFF',
  format: 'auto',
  jpgQuality: 82,
  platform: 'none',
});

// Omnisend rejects images 2000px or more on either side; Klaviyo advises full-width images under 2000px tall.
export const MAX_STRIP_PX = 2000;
export const WARN_STRIP_BYTES = 1_000_000;
export const WARN_TOTAL_BYTES = 3_000_000;
export const WARN_TALL_DESIGN = 1600;

// A problem the person can fix. The command line prints these as a numbered list.
export class UserError extends Error {
  constructor(problems, heading = 'cut-email could not continue. Nothing was written.') {
    const list = Array.isArray(problems) ? problems : [problems];
    super(list.join('\n'));
    this.name = 'UserError';
    this.problems = list;
    this.heading = heading;
  }
}

// ---------- small helpers ----------

const MERGE_TAG = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\[\[[\s\S]*?\]\]|\[%[\s\S]*?%\])/g;

export function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// Escapes text for HTML but leaves platform merge tags such as {{ first_name }} or [[unsubscribe_link]] untouched.
export function escapeKeepTags(s) {
  return String(s)
    .split(MERGE_TAG)
    .map((part, i) => (i % 2 === 1 ? part : escapeHtml(part)))
    .join('');
}

const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// HTML comments cannot contain two dashes in a row.
const comment = (text) => `<!-- ${String(text).replace(/-{2,}/g, '-')} -->`;

export function slug(name, fallback = 'strip') {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || fallback;
}

export function normaliseHex(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h.toUpperCase();
}

export function hexToRgb(hex) {
  const h = normaliseHex(hex).slice(1);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// Dark text on light backgrounds, light text on dark ones.
export function readableTextColour(background) {
  const { r, g, b } = hexToRgb(background);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.36 ? '#222222' : '#FFFFFF';
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function suggest(key, allowed) {
  let best = null;
  for (const k of allowed) {
    const dist = editDistance(key.toLowerCase(), k.toLowerCase());
    if (dist <= 2 && (!best || dist < best.dist)) best = { k, dist };
  }
  return best?.k ?? null;
}

const isIgnoredKey = (k) => k.startsWith('_') || k === 'comment';

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k) || isIgnoredKey(k)) continue;
    const s = suggest(k, allowed);
    errors.push(
      `${where} has a setting called "${k}" that cut-email does not use here.` +
        (s ? ` Did you mean "${s}"?` : '') +
        ` Allowed settings: ${allowed.join(', ')}. (Start a key with _ if it is just a note to yourself.)`
    );
  }
}

/** Returns null if the link is fine, otherwise a plain-English reason. */
export function linkProblem(link) {
  if (typeof link !== 'string' || !link.trim()) return 'is empty';
  const l = link.trim();
  const outsideTags = l.replace(MERGE_TAG, '');
  const tags = l.match(MERGE_TAG) || [];
  if (tags.some((t) => t.includes('"')))
    return 'has a double quote (") inside a merge tag. Use single quotes inside the tag instead, or the link will break';
  if (/^(\{\{|\{%|\[\[|\[%)/.test(l)) return null;
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(l)) return null;
  if (/^http:\/\//i.test(l)) return 'starts with http://. Use the secure https:// version of the address';
  if (!/^https:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(l))
    return 'is not a full web address. Links must start with https:// (for example https://yourbrand.com/products/x), or be a platform merge tag that starts with {{, {% or [[';
  if (/\s/.test(outsideTags)) return 'contains a space. Web addresses cannot contain spaces; copy the link again from your browser';
  return null;
}

const rowLabel = (i, row) => {
  if (row && typeof row === 'object' && row.live) return `Row ${i + 1} (live ${row.live})`;
  if (row && typeof row === 'object' && row.name) return `Row ${i + 1} ("${row.name}")`;
  return `Row ${i + 1}`;
};

// ---------- 1. settings check (no image needed) ----------

const TOP_KEYS = ['name', 'designWidth', 'background', 'format', 'jpgQuality', 'platform', 'preheader', 'rows'];
const IMAGE_KEYS = ['name', 'to', 'link', 'alt', 'decorative', 'format', 'allowTall'];
const COLUMN_ROW_KEYS = ['name', 'to', 'columns', 'format', 'allowTall'];
const CELL_KEYS = ['width', 'link', 'alt', 'decorative', 'format'];
const LIVE_KEYS = {
  cart: ['live', 'to', 'file'],
  html: ['live', 'to', 'file'],
  text: ['live', 'to', 'text', 'align', 'textColour', 'background'],
  footer: ['live', 'to', 'address', 'note', 'background', 'textColour'],
};
const FORMATS = ['auto', 'jpg', 'png'];

function readFormat(value, where, errors) {
  if (value === undefined) return undefined;
  const v = String(value).toLowerCase() === 'jpeg' ? 'jpg' : String(value).toLowerCase();
  if (!FORMATS.includes(v)) {
    errors.push(`${where}: "format" is "${value}". Use "auto", "jpg" or "png".`);
    return undefined;
  }
  return v;
}

function readImagePiece(piece, where, errors, warnings) {
  const decorative = piece.decorative === true;
  if (piece.decorative !== undefined && typeof piece.decorative !== 'boolean')
    errors.push(`${where}: "decorative" must be true or false, without quotes.`);
  let link = piece.link;
  if (link !== undefined && link !== null) {
    const p = linkProblem(link);
    if (p) errors.push(`${where}: the link "${link}" ${p}.`);
    link = typeof link === 'string' ? link.trim() : link;
  } else link = null;
  if (!decorative && !link)
    errors.push(
      `${where} has no "link". Every strip that is not decoration should be clickable. Add "link": "https://...", or add "decorative": true if it is only a spacer or divider.`
    );
  const alt = cleanText(piece.alt);
  if (!decorative && !alt)
    errors.push(
      `${where} has no "alt" text. Alt text is what people see when images are switched off, and what screen readers read out. Type the words shown in this strip, for example "alt": "10% off your first order. Use code HELLO10."`
    );
  if (decorative && link)
    warnings.push(`${where} is marked decorative but has a link. Screen readers will read the web address out. Remove the link, or give it alt text and remove "decorative".`);
  return { link, alt: decorative ? '' : alt, decorative };
}

/**
 * Checks cuts.json before any image is opened.
 * Returns { errors, warnings, config } where config has defaults filled in.
 */
export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      errors: ['cuts.json must be one settings object: it starts with { and ends with }. See example/cuts.example.json.'],
      warnings,
      config: null,
    };
  }
  unknownKeys(raw, TOP_KEYS, 'cuts.json', errors);

  const config = { ...DEFAULTS };
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push('"name" must be some text, for example "welcome-1".');
    else config.name = raw.name.trim();
  }
  if (raw.designWidth !== undefined) {
    if (!Number.isInteger(raw.designWidth) || raw.designWidth < 100)
      errors.push(`"designWidth" is ${JSON.stringify(raw.designWidth)}. It should be the width of the Paper artboard as a whole number, normally 600.`);
    else config.designWidth = raw.designWidth;
  }
  if (raw.background !== undefined) {
    const hex = normaliseHex(raw.background);
    if (!hex) errors.push(`"background" is ${JSON.stringify(raw.background)}. Use a colour code like "#FFFFFF".`);
    else config.background = hex;
  }
  const fmt = readFormat(raw.format, 'cuts.json', errors);
  if (fmt) config.format = fmt;
  if (raw.jpgQuality !== undefined) {
    if (!Number.isInteger(raw.jpgQuality) || raw.jpgQuality < 1 || raw.jpgQuality > 100)
      errors.push(`"jpgQuality" is ${JSON.stringify(raw.jpgQuality)}. Use a whole number from 1 to 100. 82 is a good default.`);
    else config.jpgQuality = raw.jpgQuality;
  }
  if (raw.platform !== undefined) {
    const p = String(raw.platform).toLowerCase();
    if (!platformNames.includes(p)) errors.push(`"platform" is "${raw.platform}". Use "klaviyo", "omnisend" or "none".`);
    else config.platform = p;
  }
  if (raw.preheader !== undefined) {
    if (typeof raw.preheader !== 'string') errors.push('"preheader" must be some text in quotes.');
    else if (raw.preheader.trim()) config.preheader = cleanText(raw.preheader);
  }

  if (!Array.isArray(raw.rows) || raw.rows.length === 0) {
    errors.push('cuts.json has no "rows" list. Add "rows": [ ... ] with one entry per strip, top to bottom.');
    return { errors, warnings, config };
  }

  const rows = [];
  let lastTo = null; // { value, label }
  let sawEnd = null;
  raw.rows.forEach((row, i) => {
    const where = rowLabel(i, row);
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${where} must be a settings object in curly brackets { }.`);
      return;
    }
    const out = { row: i + 1 };

    // the "to" line, shared by every row type that uses image height
    if (row.to !== undefined) {
      if (row.to === 'end') out.to = 'end';
      else if (typeof row.to === 'number' && Number.isFinite(row.to) && row.to > 0) out.to = row.to;
      else
        errors.push(
          `${where}: "to" is ${JSON.stringify(row.to)}. It should be the y position in Paper where this strip ends, as a number without quotes (for example 820), or "end" for the very bottom.`
        );
      if (out.to !== undefined) {
        if (sawEnd) errors.push(`${where} comes after ${sawEnd}, which already goes to "end". Only the last cut can use "end".`);
        else if (out.to === 'end') sawEnd = where;
        else if (lastTo && out.to <= lastTo.value)
          errors.push(
            `${where} ends at ${out.to}, but ${lastTo.label} already ends at ${lastTo.value}. Each "to" must be bigger than the one before it, because rows run top to bottom.`
          );
        if (typeof out.to === 'number') lastTo = { value: out.to, label: where };
      }
    }

    if (row.live !== undefined) {
      const kind = String(row.live).toLowerCase();
      if (!LIVE_KEYS[kind]) {
        errors.push(`${where}: "live" is "${row.live}". Use "cart", "html", "text" or "footer".`);
        return;
      }
      unknownKeys(row, LIVE_KEYS[kind], where, errors);
      Object.assign(out, { type: 'live', live: kind });
      if (kind === 'html' || kind === 'cart') {
        if (row.file !== undefined) {
          if (typeof row.file !== 'string' || !row.file.trim()) errors.push(`${where}: "file" must be the name of an HTML file next to cuts.json, in quotes.`);
          else out.file = row.file.trim();
        } else if (kind === 'html') {
          errors.push(`${where} needs a "file": the name of the HTML file to insert, for example "file": "my-snippet.html". The file goes in the same folder as cuts.json.`);
        }
      }
      if (kind === 'text') {
        if (typeof row.text !== 'string' || !row.text.trim())
          errors.push(`${where} needs "text": the words to show as live text, for example "text": "Free shipping on orders over $100."`);
        else out.text = row.text.trim();
        const align = row.align === undefined ? 'center' : String(row.align).toLowerCase();
        if (!['left', 'center', 'centre', 'right'].includes(align)) errors.push(`${where}: "align" is "${row.align}". Use "left", "center" or "right".`);
        out.align = align === 'centre' ? 'center' : align;
      }
      if (kind === 'text' || kind === 'footer') {
        for (const key of ['background', 'textColour']) {
          if (row[key] === undefined) continue;
          const hex = normaliseHex(row[key]);
          if (!hex) errors.push(`${where}: "${key}" is ${JSON.stringify(row[key])}. Use a colour code like "#0B1647".`);
          else out[key] = hex;
        }
      }
      if (kind === 'footer') {
        if (row.address !== undefined) {
          if (typeof row.address !== 'string' || !row.address.trim()) errors.push(`${where}: "address" must be your business name and postal address, in quotes.`);
          else out.address = cleanText(row.address);
        }
        if (row.note !== undefined) {
          if (typeof row.note !== 'string') errors.push(`${where}: "note" must be some text in quotes.`);
          else if (row.note.trim()) out.note = cleanText(row.note);
        }
      }
      rows.push(out);
      return;
    }

    if (row.columns !== undefined) {
      unknownKeys(row, COLUMN_ROW_KEYS, where, errors);
      Object.assign(out, { type: 'columns', name: slug(row.name, 'columns'), label: row.name ?? `row ${i + 1}` });
      const rowFormat = readFormat(row.format, where, errors);
      out.allowTall = row.allowTall === true;
      if (out.to === undefined && row.to === undefined)
        errors.push(`${where} has no "to". Every image row needs "to": the y position in Paper where this strip ends.`);
      if (!Array.isArray(row.columns) || row.columns.length < 2) {
        errors.push(`${where}: "columns" must be a list of at least two columns. For a single full-width image, remove "columns" and use "link" and "alt" on the row.`);
        return;
      }
      let sum = 0;
      let widthsOk = true;
      out.cells = row.columns.map((cell, c) => {
        const cw = `${where}, column ${c + 1}`;
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
          errors.push(`${cw} must be a settings object in curly brackets { }.`);
          widthsOk = false;
          return null;
        }
        unknownKeys(cell, CELL_KEYS, cw, errors);
        if (!Number.isInteger(cell.width) || cell.width <= 0) {
          errors.push(`${cw}: "width" is ${JSON.stringify(cell.width)}. Use the column's width in Paper as a whole number, for example 300.`);
          widthsOk = false;
        } else sum += cell.width;
        const piece = readImagePiece(cell, cw, errors, warnings);
        return { width: cell.width, ...piece, format: readFormat(cell.format, cw, errors) ?? rowFormat };
      });
      if (widthsOk && sum !== config.designWidth)
        errors.push(
          `${where}: the column widths add up to ${sum}, but the email is ${config.designWidth} wide. Change the widths so they add up to exactly ${config.designWidth} (for example ${Math.floor(config.designWidth / row.columns.length)} each${config.designWidth % row.columns.length ? ', with the remainder added to one column' : ''}).`
        );
      rows.push(out);
      return;
    }

    unknownKeys(row, IMAGE_KEYS, where, errors);
    Object.assign(out, { type: 'image', name: slug(row.name), label: row.name ?? `row ${i + 1}` });
    if (row.to === undefined) errors.push(`${where} has no "to". Every image row needs "to": the y position in Paper where this strip ends.`);
    out.allowTall = row.allowTall === true;
    Object.assign(out, readImagePiece(row, where, errors, warnings));
    out.format = readFormat(row.format, where, errors);
    rows.push(out);
  });

  if (!rows.some((r) => r.type === 'image' || r.type === 'columns'))
    errors.push('cuts.json has no image rows. Add at least one row with "to", "link" and "alt".');
  if (lastTo === null && !sawEnd && rows.length) errors.push('No row has a "to", so cut-email cannot tell where to cut.');

  const footers = rows.filter((r) => r.live === 'footer');
  if (footers.length > 1) errors.push('cuts.json has more than one live footer. Keep one, at the bottom.');
  for (const f of footers) {
    const needs = platforms[config.platform].needsAddress;
    if (needs && !f.address)
      errors.push(
        `Row ${f.row} (live footer) needs "address": your business name and postal address, for example "address": "Oakline Home Pty Ltd, 1 Example Street, Sydney NSW 2000". Email laws and inbox providers expect it in every marketing email.`
      );
    if (!needs && f.address)
      warnings.push(`Row ${f.row} (live footer): Klaviyo fills in your business name and address from your account settings, so "address" is not used.`);
  }
  if (!footers.length)
    warnings.push('There is no live footer row. Add { "live": "footer" } at the bottom so the unsubscribe link and address are real text, not part of an image.');

  config.rows = rows;
  return { errors, warnings, config };
}

// ---------- 2. planning: design pixels to file pixels ----------

/**
 * Works out exactly which pixels each strip takes, once the image size is known.
 * Returns { errors, warnings, plan }.
 */
export function planCuts(config, { width, height }) {
  const errors = [];
  const warnings = [];
  const dw = config.designWidth;
  const scale = width / dw;
  if (!Number.isInteger(scale) || scale < 1) {
    errors.push(
      `The image is ${width} pixels wide. With "designWidth" ${dw}, that is a scale of ${+(width / dw).toFixed(3)}, which is not a whole number. Export the artboard from Paper at exactly 2x (${dw * 2} pixels wide), or check "designWidth" matches the artboard width.`
    );
    return { errors, warnings, plan: null };
  }
  const designHeight = height / scale;
  if (scale === 1)
    warnings.push(`The master is 1x (${width} pixels wide). Text will look soft on phones and high-resolution screens. Export from Paper at 2x if you can.`);

  const items = [];
  const strips = [];
  let prevPx = 0;
  let number = 0;
  let positionProblem = false;
  const maxDesign = MAX_STRIP_PX / scale;

  for (const row of config.rows) {
    const where = rowLabel(row.row - 1, row.type === 'live' ? row : { name: row.label });
    let bottomPx = null;
    if (row.to !== undefined) {
      if (row.to === 'end') bottomPx = height;
      else {
        const px = row.to * scale;
        if (!Number.isInteger(px)) {
          errors.push(`${where} ends at ${row.to}. At ${scale}x that is not a whole pixel row. Use a whole number${scale === 2 ? ' or a .5 value' : ''}.`);
          positionProblem = true;
          continue;
        }
        if (row.to > designHeight) {
          errors.push(`${where} ends at ${row.to}, but the image is only ${designHeight} tall in Paper. Check the y position, or use "end" for the bottom.`);
          positionProblem = true;
          continue;
        }
        bottomPx = px;
      }
    }

    if (row.type === 'live') {
      const item = { ...row, replaces: null };
      if (bottomPx !== null) {
        item.replaces = {
          pixels: { left: 0, top: prevPx, width, height: bottomPx - prevPx },
          design: { left: 0, top: prevPx / scale, width: dw, height: (bottomPx - prevPx) / scale },
        };
        prevPx = bottomPx;
      }
      items.push(item);
      continue;
    }
    if (bottomPx === null) continue;

    const hPx = bottomPx - prevPx;
    const hDesign = hPx / scale;
    if (hPx >= MAX_STRIP_PX && !row.allowTall) {
      const split = Math.round((prevPx / scale + hDesign / 2) * 2) / 2;
      errors.push(
        `${where} is ${hDesign} pixels tall in Paper (${hPx} pixels in the file). Omnisend rejects images 2000 pixels or taller and Klaviyo advises staying under 2000, so every strip must be under ${maxDesign} in Paper. Add a cut: split this row into two rows, for example one ending at ${split} and the next at ${row.to}. Pick a line in Paper with no text crossing it. (If you really need one tall image, add "allowTall": true to this row.)`
      );
    } else if (hPx >= MAX_STRIP_PX) {
      warnings.push(`${where} is ${hPx} pixels tall in the file. "allowTall" is on, but Omnisend will reject an image this tall.`);
    }
    if (hDesign > WARN_TALL_DESIGN)
      warnings.push(`${where} is ${hDesign} pixels tall in Paper. Long single images load slowly on phones; consider another cut.`);

    number += 1;
    const top = prevPx;
    prevPx = bottomPx;
    const base = {
      row: row.row,
      number,
      name: row.name,
      design: { left: 0, top: top / scale, width: dw, height: hDesign },
      pixels: { left: 0, top, width, height: hPx },
    };
    if (row.type === 'image') {
      const strip = { ...base, letter: null, link: row.link, alt: row.alt, decorative: row.decorative, format: row.format ?? config.format };
      items.push({ type: 'image', ...strip, strip });
      strips.push(strip);
    } else {
      let left = 0;
      const cells = row.cells.map((cell, c) => {
        const strip = {
          ...base,
          letter: String.fromCharCode(97 + c),
          design: { left, top: base.design.top, width: cell.width, height: hDesign },
          pixels: { left: left * scale, top, width: cell.width * scale, height: hPx },
          link: cell.link,
          alt: cell.alt,
          decorative: cell.decorative,
          format: cell.format ?? config.format,
        };
        left += cell.width;
        strips.push(strip);
        return strip;
      });
      items.push({ type: 'columns', ...base, cells });
    }
  }

  if (!positionProblem && prevPx !== height) {
    const lastDesign = prevPx / scale;
    errors.push(
      `The last cut ends at ${lastDesign}, but the image is ${designHeight} tall in Paper, so the bottom ${designHeight - lastDesign} would be lost. Set the last row's "to" to ${designHeight}, or to "end".`
    );
  }

  const pad = Math.max(2, String(number).length);
  for (const s of strips) s.base = `${String(s.number).padStart(pad, '0')}-${s.name}${s.letter ? '-' + s.letter : ''}@${scale}x`;

  const plan = {
    name: config.name,
    platform: config.platform,
    preheader: config.preheader ?? null,
    background: config.background,
    format: config.format,
    jpgQuality: config.jpgQuality,
    designWidth: dw,
    designHeight,
    scale,
    width,
    height,
    items,
    strips,
  };
  return { errors, warnings, plan };
}

/** Proves the plan covers every pixel exactly once: no gaps, no overlaps. Returns a list of problems. */
export function checkCoverage(plan) {
  const problems = [];
  const regions = [];
  for (const item of plan.items) {
    if (item.type === 'live') {
      if (item.replaces) regions.push({ top: item.replaces.pixels.top, height: item.replaces.pixels.height, label: `live ${item.live}` });
      continue;
    }
    regions.push({ top: item.pixels.top, height: item.pixels.height, label: `strip ${item.number}` });
    if (item.type === 'columns') {
      let x = 0;
      for (const c of item.cells) {
        if (c.pixels.left !== x) problems.push(`Strip ${item.number}: column ${c.letter} starts at x ${c.pixels.left}, expected ${x}.`);
        x = c.pixels.left + c.pixels.width;
      }
      if (x !== plan.width) problems.push(`Strip ${item.number}: columns cover ${x} of ${plan.width} pixels.`);
    }
  }
  let y = 0;
  for (const r of regions) {
    if (!Number.isInteger(r.top) || !Number.isInteger(r.height) || r.height <= 0) problems.push(`${r.label} has an invalid size.`);
    if (r.top !== y) problems.push(`${r.label} starts at pixel row ${r.top}, expected ${y} (${r.top > y ? 'gap' : 'overlap'}).`);
    y = r.top + r.height;
  }
  if (y !== plan.height) problems.push(`The cuts cover ${y} of ${plan.height} pixel rows.`);
  return problems;
}

// ---------- 3. HTML ----------

function imgHtml(strip, plan, srcFor) {
  const altColour = readableTextColour(plan.background);
  const w = strip.design.width;
  const im =
    `<img src="${escapeHtml(srcFor(strip.file))}" width="${w}" alt="${escapeKeepTags(strip.alt)}" ` +
    `style="display:block;width:100%;max-width:${w}px;height:auto;border:0;margin:0;outline:none;text-decoration:none;` +
    `color:${altColour};font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:20px;">`;
  if (!strip.link) return im;
  return `<a href="${escapeKeepTags(strip.link)}" target="_blank" style="display:block;border:0;text-decoration:none;">${im}</a>`;
}

const cellStyle = 'padding:0;font-size:0;line-height:0;';

function stripRowHtml(item, plan, srcFor) {
  if (item.type === 'image') return `<tr><td style="${cellStyle}">${imgHtml(item.strip, plan, srcFor)}</td></tr>`;
  const cells = item.cells
    .map((c) => {
      const pct = +((c.design.width / plan.designWidth) * 100).toFixed(4);
      return `<td width="${pct}%" valign="top" style="${cellStyle}">${imgHtml(c, plan, srcFor)}</td>`;
    })
    .join('');
  return (
    `<tr><td style="${cellStyle}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;table-layout:fixed;border-collapse:collapse;"><tr>${cells}</tr></table></td></tr>`
  );
}

function snippetRowHtml(content) {
  const trimmed = content.trim();
  if (/^<tr[\s>]/i.test(trimmed)) return trimmed;
  return `<tr><td style="padding:0;">${trimmed}</td></tr>`;
}

function liveTextHtml(item, plan) {
  const bg = item.background ?? plan.background;
  const colour = item.textColour ?? readableTextColour(bg);
  const text = escapeKeepTags(item.text).replace(/\r?\n/g, '<br>');
  return (
    `<tr><td align="${item.align}" bgcolor="${bg}" style="background:${bg};padding:24px 44px;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:${colour};text-align:${item.align};">${text}</td></tr>`
  );
}

function liveFooterHtml(item, plan) {
  const bg = item.background ?? plan.background;
  return footerHtml({
    platform: plan.platform,
    address: item.address,
    note: item.note,
    background: bg,
    textColour: item.textColour ?? readableTextColour(bg),
  });
}

function tableOpen(plan) {
  const bg = plan.background;
  return (
    `<table role="presentation" align="center" width="${plan.designWidth}" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" ` +
    `style="width:100%;max-width:${plan.designWidth}px;margin:0 auto;background:${bg};table-layout:fixed;border-collapse:collapse;">`
  );
}

function preheaderHtml(text) {
  return (
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">` +
    `${escapeKeepTags(text)}${'&nbsp;&zwnj;'.repeat(40)}</div>`
  );
}

function cartPlaceholderPreview(plan) {
  const label = platforms[plan.platform].cartPreviewLabel;
  return (
    `${tableOpen(plan)}<tr><td style="padding:28px 24px;border:2px dashed #C2185B;background:#FDEEF4;text-align:center;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#7A1240;">${escapeHtml(label)}</td></tr></table>`
  );
}

/**
 * Splits the email into HTML blocks. A live cart without a file is a native platform block,
 * so the HTML has to stop before it and start again after it.
 */
export function segments(plan, snippets = {}) {
  const out = [];
  let current = null;
  for (const item of plan.items) {
    if (item.type === 'live' && item.live === 'cart' && !item.file) {
      current = null;
      out.push({ kind: 'native', item });
      continue;
    }
    if (!current) {
      current = { kind: 'html', items: [] };
      out.push(current);
    }
    current.items.push(item);
  }
  return out;
}

/**
 * email.html: the paste-ready HTML. srcFor maps a strip file name to its src value.
 * snippets maps a live row's file name to that file's HTML.
 */
export function buildEmailHtml(plan, { snippets = {}, srcFor = (f) => f, preview = false } = {}) {
  const segs = segments(plan);
  const htmlBlocks = segs.filter((s) => s.kind === 'html').length;
  const label = platforms[plan.platform].label;
  const parts = [];
  if (!preview) {
    parts.push(comment(`Made with cut-email for "${plan.name}".`));
    if (htmlBlocks > 1)
      parts.push(
        comment(
          `This email has a live cart in the middle, so it is ${htmlBlocks} HTML blocks. Paste each block into its own custom HTML block in ${label}, in order, with the live cart between them. Set every block's padding to 0 on all sides.`
        )
      );
    else parts.push(comment(`Paste all of this into ONE custom HTML block in ${label} and set the block's padding to 0 on all sides.`));
    parts.push(comment('Image addresses are still file names. Upload the strips, then run the host command to swap in the hosted links.'));
  }
  let blockNo = 0;
  let preheaderDone = false;
  for (const seg of segs) {
    if (seg.kind === 'native') {
      parts.push(preview ? cartPlaceholderPreview(plan) : comment(platforms[plan.platform].cartInstruction));
      continue;
    }
    blockNo += 1;
    if (htmlBlocks > 1 && !preview) parts.push(comment(`===== HTML BLOCK ${blockNo} of ${htmlBlocks}: START =====`));
    if (plan.preheader && !preheaderDone) {
      parts.push(preheaderHtml(plan.preheader));
      preheaderDone = true;
    }
    const rows = seg.items.map((item) => {
      if (item.type !== 'live') return stripRowHtml(item, plan, srcFor);
      if (item.live === 'text') return liveTextHtml(item, plan);
      if (item.live === 'footer') return liveFooterHtml(item, plan);
      const content = snippets[item.file];
      if (content === undefined) throw new Error(`Missing snippet content for ${item.file}`);
      return comment(`Live ${item.live} from ${item.file}`) + '\n' + snippetRowHtml(content);
    });
    parts.push(tableOpen(plan) + '\n' + rows.join('\n') + '\n</table>');
    if (htmlBlocks > 1 && !preview) parts.push(comment(`===== HTML BLOCK ${blockNo} of ${htmlBlocks}: END =====`));
  }
  if (plan.preheader && !preheaderDone) parts.unshift(preheaderHtml(plan.preheader));
  return parts.join('\n') + '\n';
}

/** preview.html: a page to open in a browser, desktop and phone widths side by side. */
export function buildPreviewHtml(plan, { snippets = {} } = {}) {
  const body = buildEmailHtml(plan, { snippets, srcFor: (f) => 'strips/' + f, preview: true });
  const title = escapeHtml(plan.name);
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview: ${title}</title>
<style>
body{margin:0;background:#EEF0F3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1d1d1f}
.intro{max-width:1015px;margin:0 auto;padding:24px 16px 0;font-size:14px;line-height:1.5;color:#444}
.wrap{display:flex;flex-wrap:wrap;gap:40px;justify-content:center;align-items:flex-start;padding:24px 16px 48px}
.frame h2{margin:0 0 10px;font-size:13px;font-weight:600;color:#555}
.desktop{width:600px}.phone{width:375px}
.mail{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12)}
</style>
</head>
<body>
<p class="intro"><strong>${title}</strong>: preview only. Left is desktop width (600px), right is phone width (375px). Pink dashed boxes are live parts your email platform fills in. Merge tags show as plain text here.</p>
<div class="wrap">
<div class="frame desktop"><h2>Desktop, 600px</h2><div class="mail">
${body}</div></div>
<div class="frame phone"><h2>Phone, 375px</h2><div class="mail">
${body}</div></div>
</div>
</body>
</html>
`;
}

// ---------- 4. blocks.md for drag-and-drop editors ----------

const mdCell = (s) => String(s ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];

export function buildBlocksMd(plan) {
  const label = platforms[plan.platform].label;
  const pad = 'padding 0 on all sides';
  const lines = [
    `# Block list: ${plan.name}`,
    '',
    `For building this email in ${plan.platform === 'none' ? 'your platform' : label}'s drag-and-drop editor instead of pasting email.html.`,
    '',
    `Work top to bottom. For every image block: upload the file from the strips folder, paste the link, paste the alt text, set ${pad}, turn off any border, and make the image fill the full width. Even a 1 pixel gap between blocks shows up as a line.`,
    '',
    '| Block | Type | File(s) | Link | Alt text | Spacing |',
    '|---|---|---|---|---|---|',
  ];
  let n = 0;
  for (const item of plan.items) {
    n += 1;
    if (item.type === 'image') {
      const s = item.strip;
      lines.push(`| ${n} | Image | ${mdCell(s.file)} | ${mdCell(s.link ?? 'none (decorative)')} | ${mdCell(s.alt || '(leave empty)')} | ${pad} |`);
    } else if (item.type === 'columns') {
      const count = item.cells.length;
      const type = `${COUNT_WORDS[count] ?? count} images side by side`;
      const files = item.cells.map((c) => `${c.letter}: ${c.file}`).join('\n');
      const links = item.cells.map((c) => `${c.letter}: ${c.link ?? 'none (decorative)'}`).join('\n');
      const alts = item.cells.map((c) => `${c.letter}: ${c.alt || '(leave empty)'}`).join('\n');
      lines.push(`| ${n} | ${type} | ${mdCell(files)} | ${mdCell(links)} | ${mdCell(alts)} | ${pad}, and no gap between the columns |`);
    } else if (item.live === 'cart') {
      const what = item.file
        ? `Custom HTML block: paste the contents of ${item.file}`
        : plan.platform === 'omnisend'
          ? 'Add Omnisend\'s "Abandoned Products" item here (one per email)'
          : plan.platform === 'klaviyo'
            ? 'Add a Klaviyo Table block set to dynamic, using the product rows from the cart or checkout event'
            : "Add your platform's live cart or product block here";
      lines.push(`| ${n} | Live cart block | ${mdCell(item.file ?? 'none')} | ${mdCell(what)} |  | ${pad} |`);
    } else if (item.live === 'html') {
      lines.push(`| ${n} | Custom HTML block | ${mdCell(item.file)} | Paste the contents of ${mdCell(item.file)} |  | ${pad} |`);
    } else if (item.live === 'text') {
      lines.push(`| ${n} | Live text | none | Text block, Arial or Helvetica 16px, ${item.align === 'center' ? 'centred' : item.align + '-aligned'} | ${mdCell(item.text)} | padding 24px top and bottom, 44px left and right |`);
    } else if (item.live === 'footer') {
      const what =
        plan.platform === 'klaviyo'
          ? 'Text block with {% unsubscribe %}, {% manage_preferences %}, {{ organization.name }} and {{ organization.full_address }}'
          : plan.platform === 'omnisend'
            ? `Text block with an Unsubscribe link to [[unsubscribe_link]], a Manage preferences link to [[preference_link]], and: ${item.address}`
            : `Text block with your unsubscribe link, preferences link and: ${item.address}`;
      lines.push(`| ${n} | Live footer | none | ${mdCell(what)} |  | ${pad} |`);
    }
  }
  lines.push(
    '',
    'Notes:',
    '',
    '- Side-by-side rows only line up if the column gap is 0. If your editor will not let you set the gap to 0, use email.html (the HTML block route) for this email instead.',
    '- The footer stays as live text on purpose. Spam filters and both platforms warn against emails that are only images.',
    ''
  );
  return lines.join('\n');
}

// ---------- 5. hosting: swap file names for uploaded image links ----------

/**
 * Reads the links file. Plain text: one https link per line, in strip order (blank lines and lines
 * starting with # are skipped). JSON: { "01-hero@2x.jpg": "https://..." }.
 */
export function parseUrlsFile(text, { json } = {}) {
  const trimmed = String(text).replace(/^﻿/, '').trim();
  const looksJson = json ?? trimmed.startsWith('{');
  if (looksJson) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      throw new UserError(`The links file looks like JSON but cannot be read: ${e.message}. Check for a missing comma or quote.`, 'cut-email could not read the links file. Nothing was written.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new UserError('The links file must be { "strip file name": "https://link", ... }, or a plain text file with one link per line.', 'cut-email could not read the links file. Nothing was written.');
    return { kind: 'map', map: data };
  }
  const list = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return { kind: 'list', list };
}

/** Pairs each strip file with its hosted link. Returns { errors, pairs }. */
export function matchUrls(files, parsed) {
  const errors = [];
  let pairs = [];
  if (parsed.kind === 'list') {
    if (parsed.list.length !== files.length) {
      errors.push(
        `The links file has ${parsed.list.length} link${parsed.list.length === 1 ? '' : 's'}, but this email has ${files.length} strips. Give one link per strip, in this order:\n` +
          files.map((f, i) => `     ${i + 1}. ${f}`).join('\n')
      );
      return { errors, pairs };
    }
    pairs = files.map((file, i) => ({ file, url: parsed.list[i] }));
  } else {
    const byName = new Map();
    for (const [k, v] of Object.entries(parsed.map)) byName.set(k.split('/').pop(), v);
    const missing = files.filter((f) => !byName.has(f));
    const extra = [...byName.keys()].filter((k) => !files.includes(k));
    if (missing.length) errors.push(`The links file has no link for: ${missing.join(', ')}.`);
    if (extra.length) errors.push(`The links file names files that are not strips of this email: ${extra.join(', ')}. Check the spelling against the strips folder.`);
    if (errors.length) return { errors, pairs };
    pairs = files.map((file) => ({ file, url: byName.get(file) }));
  }
  const seen = new Map();
  for (const { file, url } of pairs) {
    if (typeof url !== 'string' || !/^https:\/\/[^\s/?#]+\.[^\s/?#]+\S*$/i.test(url.trim())) {
      errors.push(`The link for ${file} is ${JSON.stringify(url)}. Hosted image links must be full https:// addresses with no spaces.`);
      continue;
    }
    const u = url.trim();
    if (seen.has(u)) errors.push(`The same link is given for ${seen.get(u)} and ${file}. Each strip needs its own uploaded image link. Check you copied the right one.`);
    else seen.set(u, file);
  }
  return { errors, pairs: pairs.map((p) => ({ file: p.file, url: typeof p.url === 'string' ? p.url.trim() : p.url })) };
}

/** Swaps src="file" for src="link". Returns { errors, html }. */
export function substituteUrls(html, pairs) {
  const errors = [];
  let out = html;
  for (const { file, url } of pairs) {
    const needle = `src="${escapeHtml(file)}"`;
    const count = out.split(needle).length - 1;
    if (count !== 1) {
      errors.push(`email.html has ${count === 0 ? 'no' : count} image${count === 1 ? '' : 's'} pointing at ${file}. email.html may have been edited by hand; run the cut command again into a new folder.`);
      continue;
    }
    out = out.replace(needle, `src="${escapeHtml(url)}"`);
  }
  return { errors, html: out };
}
