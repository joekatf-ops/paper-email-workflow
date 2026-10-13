# cut-email

You design an email in Paper as one tall picture, 600 pixels wide. cut-email slices that picture into horizontal strips, saves each strip as an image file, and writes the HTML (the code an email is made of) that stacks those strips back together with no gaps, each one clickable. It keeps the parts that must be live text, like the unsubscribe footer, as real text, and leaves a marked spot for live content like an abandoned cart. Then it checks its own work: it rebuilds the email from the strips and compares it with your design, pixel by pixel.

You will usually ask Claude (your AI assistant) to run it for you. This page explains what it does so you can follow along and fix things yourself.

## One-time setup

1. **Install Node.js.** Node.js is the free program that runs this tool. Go to [nodejs.org](https://nodejs.org), download the version marked **LTS** (long-term support, meaning the stable one) and install it like any other app.
2. **Open Terminal in this folder.** Terminal is the Mac app where you type commands. In Finder, right-click the `cut-email` folder and choose **New Terminal at Folder**. (On Windows, use the "Open in Terminal" option.)
3. **Install the tool's parts.** Type this and press Enter:

   ```
   npm ci
   ```

   npm is the installer that came with Node.js. `npm ci` downloads the exact image library this tool was tested with (called sharp) into a `node_modules` folder here. You only do this once.

To check everything works, type `npm test`. You should see `fail 0` at the end.

## The two commands

### 1. Cut the email

```
node cut-email.mjs cut "my-email@2x.png" cuts.json "exports/welcome-1"
```

- `my-email@2x.png` is your Paper export (see "Exporting from Paper" below).
- `cuts.json` is your cut plan (see "The cut plan" below).
- `exports/welcome-1` is a **new** folder for the results. The tool refuses to use a folder that already exists, so an earlier export can never be overwritten. Use a new name each time, such as `welcome-1-v2`.

Add `--dry-run` at the end to check the plan without making any files:

```
node cut-email.mjs cut "my-email@2x.png" cuts.json "exports/welcome-1" --dry-run
```

If anything is wrong, the tool stops, writes nothing, and lists each problem in plain English with what to change.

### 2. Swap in the hosted image links

Email images have to live on the internet. Upload every file in the `strips` folder to your email platform's image library (Klaviyo and Omnisend both have one), then copy each image's link into a plain text file, one link per line, in the same order as the file names (01, 02, 03 and so on). Save it as `links.txt` and run:

```
node cut-email.mjs host "exports/welcome-1" links.txt
```

This writes `email-hosted.html`, ready to paste. It stops with a clear message if the number of links does not match the number of strips, if a link is not `https://`, or if the same link appears twice. Running it again writes `email-hosted-2.html`, never overwriting the first.

(If you prefer, the links file can be JSON instead: `{ "01-hero@2x.jpg": "https://...", ... }`. JSON is a plain text settings format with curly brackets and quotes.)

## Exporting from Paper

- Design the email on one artboard 600 pixels wide.
- Export it at **2x** as PNG or JPG. 2x means double size (1200 pixels wide), so text stays sharp on phones and high-resolution screens.

## Finding the cut positions

A cut position is the **y position** (distance from the top, in Paper's own units) where one strip ends and the next begins, measured on the 600 pixel artboard. In Paper, select the section and read its Y value in the panel on the right; the bottom of a section is its Y plus its height. Or ask Claude to read the section positions from Paper for you.

Good cuts:

- **Cut between sections, never through a line of text.** The strips rejoin perfectly, but a cut through text can show a faint seam in some inboxes.
- **Keep every strip under 1000 tall in Paper** (under 2000 pixels in the 2x file). Omnisend rejects images 2000 pixels or taller and Klaviyo advises staying under 2000. The tool stops and suggests where to add a cut if a strip is too tall.
- **Give each clickable area its own strip** when it should go somewhere different, such as a button for the offer and a separate strip for the reviews link.

## The cut plan (cuts.json)

The cut plan is a JSON file: a plain text settings file. `example/cuts.example.json` is a full example for a made-up brand, Oakline Home. Copy it and change it. Any setting whose name starts with `_` is treated as a note and ignored.

### Main settings

| Setting | What it means | Default |
|---|---|---|
| `name` | A name for this email, used in titles. | the file name |
| `designWidth` | The artboard width in Paper. | `600` |
| `background` | The colour behind the email, as a colour code like `"#FFFFFF"`. See-through areas of the export are filled with it. | `"#FFFFFF"` |
| `format` | `"auto"` picks the smaller file for each strip: JPG for photos, PNG for flat graphics and text. Or force `"jpg"` or `"png"`. | `"auto"` |
| `jpgQuality` | JPG quality from 1 to 100. Lower is smaller and blurrier. | `82` |
| `platform` | `"klaviyo"`, `"omnisend"` or `"none"`. Decides the unsubscribe tags and the live cart instructions. | `"none"` |
| `preheader` | The preview text shown after the subject line in the inbox. Optional. (Your platform also has a preview text field; use one or the other, not both.) | none |
| `rows` | The list of rows, top to bottom. | required |

### Row types

| Row | Settings | What it makes |
|---|---|---|
| Image strip | `name`, `to`, `link`, `alt` | One full-width clickable image. `to` is the cut position where the strip ends. Use `"end"` for the very bottom. |
| Decorative strip | `name`, `to`, `"decorative": true` | A spacer or divider. No link, and empty alt text so screen readers skip it. |
| Side by side | `name`, `to`, `columns` | Images next to each other, such as two footer buttons. Each column has `width` (in Paper units), `link` and `alt`, or `"decorative": true`. The widths must add up to 600. |
| Live cart | `"live": "cart"` | A marked spot for the shopper's cart products. See "Live parts" below. Add `"file": "my-cart.html"` to insert your own code instead. |
| Live text | `"live": "text"`, `text`, `align` | A line of real text in Arial or Helvetica, 16px. `align` is `"left"`, `"center"` (the code spelling) or `"right"`. Optional `textColour` and `background`. |
| Live HTML | `"live": "html"`, `file` | Inserts any HTML file you give it, from the same folder as cuts.json. |
| Live footer | `"live": "footer"`, `address`, `note` | The legal footer as real text: unsubscribe link, manage preferences link and your business name and address. `note` is an optional line such as "You're getting this because you joined our list." Optional `textColour` and `background`. Klaviyo fills the address in from your account, so `address` is only needed for Omnisend and `none`. |

Other row settings:

- `link` must start with `https://`, or be a platform merge tag (a placeholder the platform fills in for each person, such as `{{ event.extra.checkout_url }}` in Klaviyo or `[[event.raw.abandoned_checkout_url]]` in Omnisend). `mailto:` email links also work.
- `alt` is alt text: the words people see when images are switched off, and what screen readers read out. Type what the strip says.
- `format` on a row overrides the main setting for that strip.
- `"allowTall": true` lets one strip go over the 2000 pixel limit. Avoid it.
- Any **live** row can also have `to`. That means "the design has a mock-up of this part drawn in Paper; skip those pixels". For example, if you drew a sample cart from 1120 to 1781, use `{ "live": "cart", "to": 1781 }` and that area is not exported. Every pixel of the design must be either a strip or replaced by a live row, so the last `to` must reach the bottom.

## What you get

| File | What it is for |
|---|---|
| `strips/` | The image files, numbered in order: `01-logo@2x.png`, `02-hero@2x.jpg`. Side-by-side columns get letters: `07-footer-nav-a@2x.png`. |
| `email.html` | The code to paste into a **custom HTML block** in your platform. Image addresses are still file names until you run the host command. |
| `preview.html` | Double-click to open in your browser. Shows the email at desktop width (600px) and phone width (375px) side by side. |
| `blocks.md` | A table of every block in order, for building in the drag-and-drop editor instead. |
| `check.png` | Your design rebuilt from the strips, with the strip numbers down the side and live areas tinted pink. Look at it before sending. |
| `manifest.json` | A record of exactly what was cut: sizes, positions, links, alt text and a fingerprint of every file. Useful for Claude and for troubleshooting. |

The tool also prints a **reassembly check**. PNG strips must match your design exactly; JPG strips must be within a tiny average difference (under 3 out of 255 per colour). If the check fails, it says so and the email should not be sent.

## Two ways to build the email in your platform

**Route 1: one HTML block (recommended).** Add a custom HTML block, set its padding to 0 on all sides, and paste `email-hosted.html`. Everything lines up exactly, including side-by-side rows.

If the email has a live cart in the middle, `email.html` is split into numbered HTML blocks with a note between them. Paste each into its own custom HTML block, in order, and put the platform's cart block between them:

- **Omnisend:** add the **Abandoned Products** item there. It works in abandoned cart, checkout and product abandonment workflows, one per email.
- **Klaviyo:** add a **Table block set to dynamic** using the product rows from the event. For Started Checkout there is a ready-made option in `example/klaviyo-started-checkout-loop.html`: use `{ "live": "cart", "file": "klaviyo-started-checkout-loop.html" }` and check it in Klaviyo's preview with a real event before sending.

**Route 2: drag and drop.** Follow `blocks.md`: one image block per strip, each with its link and alt text, padding 0 on all sides, no border, full width. Side-by-side rows need a column layout with the gap set to 0; if your editor will not allow that, use Route 1.

## Pitfalls the tool handles for you

- **Dull colours.** Paper exports use a wide colour range called Display P3. Saving them without converting makes colours look dull (a bright orange came out muddy). The tool converts every strip to sRGB, the standard colour range email apps expect, and removes the colour label from the files.
- **Black patches.** Paper leaves see-through areas wherever a section has no fill. JPG cannot be see-through, so they turn black. The tool fills them with your `background` colour first.
- **Gaps and overlaps.** Every strip is cut on whole pixel rows and they join with no gaps or overlaps. The reassembly check proves it.
- **Overwriting old work.** The tool never writes into an existing folder or replaces an existing file.
- **Images too tall.** Strips 2000 pixels or taller are stopped before anything is written.
- **Image-only emails.** Spam filters, Klaviyo and Omnisend all warn against emails that are only images. Keep the live footer and at least one short live text line.

## For whoever maintains this

- `snippets.mjs` holds the Klaviyo and Omnisend tags. They were checked against the vendors' help pages on 14 October 2026; if a test email shows a tag as plain text, check the platform's current docs and edit that file.
- `lib.mjs` holds the settings checks, the cut maths and the HTML builders, with no image work, so they can be tested quickly.
- `cut-email.mjs` does the image work and runs the commands.
- `npm test` runs every test, including real cuts of generated images, the P3 colour conversion and the see-through fill.
