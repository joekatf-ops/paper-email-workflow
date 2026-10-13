# Platform Notes: Klaviyo and Omnisend

Checked against each platform's help centre on 14 October 2026. Platforms change, so check anything critical in their docs before relying on it.

## Both

- Email width 600 px. Upload strips at 2x (1,200 px wide)
- Keep every strip under 2,000 px tall at 2x
- Strips go in with zero padding on every side, each with its own link and alt text
- Image-only emails are more likely to land in spam. Keep the legal footer as live text and consider one short live line near the top
- Gmail clips emails whose code passes about 102 KB. Only the code counts, not the images

## Klaviyo

| Need | How |
|---|---|
| Image limits | 10 MB max in the editor, 1 MB or less recommended. JPEG, PNG, GIF. Klaviyo compresses on upload unless you choose Use originals |
| No gaps | Image block padding 0, and check section styles. Block settings override section settings |
| Link and alt text | In the image block settings |
| Live cart, Started Checkout | Dynamic table, row collection `event.extra.line_items`, alias `item`. Fields: `{{ item.title }}`, `{{ item.product.images.0.src }}`, `{% currency_format item.price %}` |
| Live cart, Added to Cart | The event holds one product. Use a static table |
| Back to checkout | `{{ event.extra.checkout_url }}`, fallback `{{ event.extra.responsive_checkout_url }}`. In Added to Cart flows use `{{ event.URL }}` |
| Unsubscribe | `{% unsubscribe %}` (or `{% unsubscribe_link %}` for the URL only). Required in every email |
| Preferences | `{% manage_preferences %}` (or `{% manage_preferences_link %}`) |
| Address | `{{ organization.full_address }}` |
| Qualifying vs neutral | Conditional split: Items contains the product |
| Safe testing | Set the email to Manual: people queue for review instead of receiving it. Draft: people skip it. Cloning a live email sets the copy to Manual |
| Preview with real data | Preview, then pick a real profile or a recent event. A plain test send does not fill in event data |
| Editing a live flow | Emails can be edited while the flow runs, so back up first |
| By API | Templates can be updated by API (`PATCH /api/templates/{id}`). For a flow email, find its template ID first |

## Omnisend

| Need | How |
|---|---|
| Image limits | 5 MB max, under 2,000 px on both sides. JPEG, PNG, WebP, GIF |
| No gaps | Image block: Remove padding button. Check the layout padding too |
| Link and alt text | In the image block's right panel |
| Live cart | The Abandoned Products item, in abandoned cart, checkout and product abandonment workflows. One per email, up to 12 products |
| Back to checkout | The Checkout button's abandoned cart link preset, or `[[event.raw.abandoned_checkout_url]]` |
| Unsubscribe | Added to promotional emails automatically. You can move it, but hiding it can get the account suspended. Tag: `[[unsubscribe_link]]` |
| Preferences | `[[preference_link]]` |
| Qualifying vs neutral | A split condition on the cart contents |
| Preview with real data | Preview as one of your contacts. Test emails show no real event data |
| Editing a live workflow | Content can be edited while live. Publishing structure changes affects people already in the workflow, so read Omnisend's prompt carefully |

## HTML block route

The cut-email tool writes `email.html` for a single custom HTML block, and `blocks.md` for building block by block. Upload the strips to the platform's image library first, then give the tool the hosted links (`host` command) so the code points at them.
