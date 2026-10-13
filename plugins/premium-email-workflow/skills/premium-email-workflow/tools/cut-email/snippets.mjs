// Platform snippets for cut-email.
//
// This is the one file to edit if Klaviyo or Omnisend change their tags.
// Everything here is plain text that gets dropped into email.html.
//
// verify against current platform docs: every Klaviyo and Omnisend tag below
// was checked against the vendors' own help pages on 14 October 2026. Platforms
// rename tags from time to time, so check again if a test send shows a tag as
// plain text instead of a working link.

const esc = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const linkStyle = (colour) => `color:${colour};text-decoration:underline;`;

export const platforms = {
  omnisend: {
    label: 'Omnisend',
    // verify against current platform docs (Omnisend merge tags)
    footerLinks(colour) {
      return {
        unsubscribe: `<a href="[[unsubscribe_link]]" target="_blank" style="${linkStyle(colour)}">Unsubscribe</a>`,
        preferences: `<a href="[[preference_link]]" target="_blank" style="${linkStyle(colour)}">Manage preferences</a>`,
      };
    },
    footerAddress(address) {
      return esc(address);
    },
    needsAddress: true,
    // verify against current platform docs (Omnisend "Abandoned Products" item)
    cartInstruction:
      'LIVE CART GOES HERE. In the Omnisend editor, add the "Abandoned Products" item at this spot, ' +
      'between the HTML block above and the HTML block below. It works in abandoned cart, checkout and ' +
      'product abandonment workflows, and you can use one per email. ' +
      'Or put your own product loop in a file and add "file": "your-file.html" to this row in cuts.json.',
    cartPreviewLabel: 'Live cart: Omnisend "Abandoned Products" item goes here',
  },

  klaviyo: {
    label: 'Klaviyo',
    // verify against current platform docs (Klaviyo template tags)
    // {% unsubscribe %} and {% manage_preferences %} print a full link with Klaviyo's own wording.
    // If you want your own wording and colour, swap them for
    // <a href="{% unsubscribe_link %}">Unsubscribe</a> and <a href="{% manage_preferences_link %}">Manage preferences</a>.
    footerLinks() {
      return {
        unsubscribe: '{% unsubscribe %}',
        preferences: '{% manage_preferences %}',
      };
    },
    // verify against current platform docs (Klaviyo organisation tags)
    footerAddress() {
      return '{{ organization.name }}<br>{{ organization.full_address }}';
    },
    needsAddress: false,
    // verify against current platform docs (Klaviyo dynamic table block)
    cartInstruction:
      'LIVE CART GOES HERE. In the Klaviyo editor, drop a Table block set to dynamic at this spot, ' +
      'between the HTML block above and the HTML block below, using the product rows from the ' +
      'abandoned cart or Started Checkout event. ' +
      'Or put your own product loop in a file and add "file": "your-file.html" to this row in cuts.json. ' +
      'The example folder has klaviyo-started-checkout-loop.html to start from.',
    cartPreviewLabel: 'Live cart: Klaviyo dynamic table block goes here',
  },

  none: {
    label: 'no platform',
    footerLinks(colour) {
      return {
        unsubscribe: `<a href="[UNSUBSCRIBE_LINK]" target="_blank" style="${linkStyle(colour)}">Unsubscribe</a>`,
        preferences: `<a href="[PREFERENCES_LINK]" target="_blank" style="${linkStyle(colour)}">Manage preferences</a>`,
      };
    },
    footerAddress(address) {
      return esc(address);
    },
    needsAddress: true,
    cartInstruction:
      "LIVE CART GOES HERE. Insert your email platform's live cart or product block at this spot, " +
      'between the HTML block above and the HTML block below. ' +
      'Or put your own product loop in a file and add "file": "your-file.html" to this row in cuts.json.',
    cartPreviewLabel: 'Live cart: your platform\'s cart block goes here',
  },
};

export const platformNames = Object.keys(platforms);

/**
 * The live legal footer, as live text (never an image).
 * opts: { platform, address, note, background, textColour }
 */
export function footerHtml({ platform, address, note, background, textColour }) {
  const p = platforms[platform];
  const links = p.footerLinks(textColour);
  const noteHtml = note ? `<p style="margin:0 0 10px;">${esc(note)}</p>` : '';
  return (
    `<tr><td bgcolor="${background}" style="background:${background};color:${textColour};text-align:center;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;padding:24px 32px 32px;">` +
    noteHtml +
    `<p style="margin:0 0 10px;">No longer want these emails? ${links.unsubscribe} &middot; ${links.preferences}</p>` +
    `<p style="margin:0;">${p.footerAddress(address)}</p>` +
    `</td></tr>`
  );
}
