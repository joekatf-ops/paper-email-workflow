# The Paper Email Workflow

How we design premium, image-led emails for [Cadian Sleep](https://cadiansleep.com) with Claude and Paper, and get them live in Klaviyo or Omnisend. This repo has the full guide and a starter kit that installs into Claude Code, so you can run the same process on your own brand.

![The top of three live Cadian emails built with this workflow](guide/images/result.jpg)

## Start here

1. **Read the guide.** [The Paper Email Workflow (PDF)](The%20Paper%20Email%20Workflow.pdf), or [read it on GitHub](guide/The%20Paper%20Email%20Workflow.md). It explains the method, shows what went wrong for us, and walks through one email from brief to live.
2. **Install the starter kit** (below).
3. **Start with prompt A1** in [prompts.md](prompts.md).

## Install

You need Claude Code with a paid Claude plan, Paper Desktop, and Node.js (the LTS version from [nodejs.org](https://nodejs.org)).

**As a Claude Code plugin (easiest).** In Claude Code, type these two lines, pressing Enter after each:

```
/plugin marketplace add joekatf-ops/paper-email-workflow
/plugin install premium-email-workflow@paper-email-workflow
```

Restart Claude Code. A plugin is a package Claude Code downloads and keeps up to date for you. This one adds the email workflow skill, its reference files and the cut-email tool.

**Without the plugin.** Click Code, then Download ZIP. Copy the folder `plugins/premium-email-workflow/skills/premium-email-workflow` into a folder called `.claude/skills` inside the folder you'll do your email work from. On a Mac, press Command, Shift and full stop in Finder to see folders that start with a dot.

**Then connect Paper.** Open Paper Desktop with a file open, and click Add to Claude in Paper's connector panel. In Claude Code, type `/mcp` to check Paper shows as connected. Figma and an image generator such as Higgsfield are optional; the guide explains both.

**Then your brand.** Make a folder for your email work with a Brand folder inside it: logo files, fonts, real product photos, your offer sheet and what you can and can't claim. Open Claude Code in that folder and say:

```
Use the premium email workflow skill. We're setting up [your brand] for the first time.
```

## What's inside

| Path | What it is |
|---|---|
| `The Paper Email Workflow.pdf` | The full guide |
| `guide/` | The same guide as a GitHub page, with its figures |
| `prompts.md` | 14 copy-paste prompts, one for each step |
| `plugins/premium-email-workflow/skills/premium-email-workflow/SKILL.md` | The skill: the instructions Claude reads before any email job, including where it stops for your approval |
| `.../reference/brand-setup.md` | What to collect before the first email |
| `.../reference/design-rules.md` | The design rules template, with Cadian's values as the worked example |
| `.../reference/build-record.md` | The one-page brief every email starts from |
| `.../reference/qa-checklist.md` | Everything to check before an email goes live |
| `.../reference/figma-handoff.md` | The spec for an optional Figma review copy |
| `.../reference/platform-notes.md` | Klaviyo and Omnisend limits, merge tags, live cart setup and safe testing |
| `.../tools/cut-email/` | Cuts your design into linked strips, converts the colours, writes the email code and checks the strips fit back together. Its README explains it in plain English |

## Good to know

- Claude stops at each approval point on purpose. Approving a design doesn't let it upload anything, and building in your platform doesn't let it send.
- The Cadian values in the design rules show the level of detail to aim for. Replace them with your own brand's before your first email.
- Platform details were checked against Klaviyo's and Omnisend's help centres in October 2026. Platforms change, so check anything critical before relying on it.
- We haven't measured whether these emails convert better than our old ones. Test it on your own flows.

Built by Joe Katf while building Cadian Sleep, October 2026.
