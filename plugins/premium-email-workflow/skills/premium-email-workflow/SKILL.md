---
name: premium-email-workflow
description: Design, revise, hand off, cut and stage premium image-led ecommerce emails. The email is composed in Paper as one continuous artwork, approved at a checkpoint, cut into linked image strips with live cart and legal blocks, and built in Klaviyo or Omnisend. Use for any email flow or campaign design, a Paper comment revision, a Figma review handoff, cutting strips, building or testing the email in the platform, or a text-only change to a live email.
---

# Premium Email Workflow

Paths below are relative to this skill folder. Read the reference file each step names before doing that step.

## First, find the boundary

Work out which stage the person is asking for: brief, look exploration, new design, revision, handoff, cutting, platform build, testing, or going live. Do that stage and stop. An earlier stage never authorises a later one. A request to design is not permission to upload, a request to build is not permission to send, and a request to test is not permission to switch anything on.

For a new multi-email job, confirm the email list and the look for each email before building.

## Before any design

1. Read `reference/brand-setup.md` and the brand's design rules file (the brand's copy of `reference/design-rules.md`). If the brand pack is missing, help build it first. Do not design for a brand you have no rules for.
2. Check every offer, price, gift, code and claim against the live store and the brand's claims page today. If you cannot check a fact, mark it unverified in the build record and tell the person.
3. Start a build record from `reference/build-record.md`. Every word of copy, every link and who receives the email go in it before design starts.

## New design

1. Pick one look from the brand's looks, chosen for the message. Pick one parent reference email and describe what it contributes: background behaviour, pacing, image density, transitions. Never average several references.
2. Write the shot plan: camera, light direction, surface, crop, product position and where copy will sit, for every scene. State the image generation budget and get a yes before generating.
3. Generate a matched image family with the brand's real product photos as references. No text, logos, prices or buttons in generated images. Inspect every image against the real product and reject any that get the product wrong, however good they look.
4. In Paper, build the background first: one continuous surface for the full length. Then build only the hero, one representative middle section and the join between them. Screenshot them together at actual size and stop for approval. Do not build the rest until the person approves this checkpoint.
5. After approval, extend the same system down the email, reusing the brand's locked modules as exact copies. Never redraw the logo.
6. Check the full scroll at 600, 375 and 320 px: every join, text size and contrast, button size, product accuracy, spacing above the footer, and the hard cut into the footer. Apply `reference/design-rules.md`.
7. Record the version in the build record and stop for approval of the exact copy and artwork together.

Code is for cutting, checking and delivery only. Never compose final artwork with scripted coordinates or an HTML card stack.

## Revisions

Read the comments from the actual Paper file. Map each comment to a section. Change only what the comments ask for. Keep approved photography and unrelated copy exactly as they were. Show a before and after, recheck spacing around every change at desktop and phone size, and mark the affected approval as pending again. Never mark a comment resolved unless it was actually done.

## Figma handoff (optional)

Follow `reference/figma-handoff.md`. Use the approved export, never a rebuild. Tiles under 4,096 px. Look at the actual Figma canvas before reporting it done.

## Cutting

Use the cut-email tool in `tools/cut-email`. Read its README. The first time, check Node.js is installed (`node --version`, version 20.9 or later) and run `npm ci` inside `tools/cut-email` if its `node_modules` folder is missing. If Node.js is missing, tell the person to install the LTS version from nodejs.org and stop. Export the approved design at 2x (1,200 px wide). Plan cuts in 600 px design coordinates: one link per strip, every strip under 1,000 design px (2,000 px at 2x), cuts through calm background, live blocks where the cart and legal footer go. Run a dry run first, then the cut. Check the reassembly result and open the preview. Report strip count, total weight and any warnings.

## Platform build

Read `reference/platform-notes.md` for the brand's platform. Strips go in with zero padding, each with its link and real alt text. Cart rows, prices, recovery links, unsubscribe, preferences and address stay live. Sheet-style offers only go to people who qualify; everyone else gets the neutral version. Subject and preview text come from the build record. Build as a draft or in a safe test state. Never change triggers, delays, exits, splits or who is in a flow as a side effect of a content change.

## Testing and going live

Run `reference/qa-checklist.md`. Test sends only go to recipients the person names for this run. A platform accepting a test is not proof it arrived or rendered: check real inboxes and preview with real cart data. Going live needs the person's explicit go-ahead for the exact email and destination, a backup of what is being replaced, and a read-back afterwards.

## Text-only changes to a live email

Edit the text in Paper without changing the design's height. Export, cut at exactly the previous positions, re-upload only the changed strips, update their alt text, swap them in, then read back the whole email. If the store sells in more than one currency, flow emails carry no currency amounts.

## Finish

Update the build record: version, approval state, links, strip files and anything unverified. Tell the person exactly what changed, where to look, and what is still open. Never describe a design as converting better, or an email as delivered, unless that was actually measured or seen.
