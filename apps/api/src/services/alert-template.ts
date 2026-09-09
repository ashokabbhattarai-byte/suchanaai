/**
 * The WhatsApp alert message template: a small, dependency-free
 * Mustache-like renderer (`{{token}}` substitution, `{{#token}}...{{/token}}`
 * conditional blocks) plus the default template that reproduces
 * AlertMatchingService's original hand-built message exactly.
 *
 * Kept separate from AlertMatchingService so the same renderer backs both
 * the real send path (real notice data) and the admin preview endpoint
 * (sample data) — one implementation, never two that can drift apart.
 */

/** Every token the template may reference. Documented here once, read by
 * both the admin UI (token reference list) and buildTemplateData below. */
export const TEMPLATE_TOKENS: { token: string; description: string; optional: boolean }[] = [
  { token: 'categoryEmoji', description: 'Emoji for the notice category (📢, 📰, ...)', optional: false },
  { token: 'categoryLabel', description: 'Category name (Notice, News, Press Release, ...)', optional: false },
  { token: 'title', description: 'The notice title', optional: false },
  { token: 'organization', description: 'Issuing organization / source', optional: true },
  { token: 'publishedDate', description: 'Publish date, e.g. "7 Sep 2026"', optional: true },
  { token: 'deadlineDate', description: 'Deadline date, if the notice has one', optional: true },
  { token: 'urgencyEmoji', description: 'Emoji for AI-assessed urgency (🟢/🟡/🔴)', optional: true },
  { token: 'urgencyLabel', description: 'Urgency label (Low/Medium/High urgency)', optional: true },
  { token: 'summary', description: 'AI summary (falls back to the scraped summary)', optional: true },
  { token: 'keyFacts', description: 'Bulleted list of AI-extracted key facts (already formatted, multi-line)', optional: true },
  { token: 'matchReason', description: 'Which rule dimensions matched, e.g. "category Notice, keyword \\"budget\\""', optional: false },
  { token: 'ruleName', description: "The user's alert rule name that matched", optional: false },
  { token: 'noticeUrl', description: 'Link to the full notice — keep on its own line for WhatsApp link detection', optional: false },
  { token: 'manageUrl', description: "Link to the user's alert settings", optional: false },
];

/** Reproduces AlertMatchingService's original hardcoded message exactly. */
export const DEFAULT_WHATSAPP_TEMPLATE = `{{categoryEmoji}} *{{categoryLabel}} Alert*
───────────────
*{{title}}*
{{#organization}}
🏛️ *Organization:* {{organization}}{{/organization}}{{#publishedDate}}
📅 *Published:* {{publishedDate}}{{/publishedDate}}{{#deadlineDate}}
⏰ *Deadline:* {{deadlineDate}}{{/deadlineDate}}{{#urgencyLabel}}
{{urgencyEmoji}} *{{urgencyLabel}}*{{/urgencyLabel}}{{#summary}}

📝 *Summary:*
{{summary}}{{/summary}}{{#keyFacts}}

🔑 *Key facts:*
{{keyFacts}}{{/keyFacts}}

🔎 *Matched alert:* _{{ruleName}}_ ({{matchReason}})

🔗 *View full notice:*
{{noticeUrl}}
───────────────
_Manage your alerts:_
{{manageUrl}}`;

/**
 * Render `{{#field}}...{{/field}}` conditional blocks (dropped entirely
 * when the field is empty/falsy, otherwise the block's own `{{tokens}}`
 * are substituted), then a final flat `{{token}}` pass for everything
 * outside a block. Unknown tokens render as empty string rather than
 * throwing — an admin's typo shouldn't break every alert delivery, just
 * leave a blank where the token was meant to be.
 */
export function renderTemplate(template: string, data: Record<string, string>): string {
  let out = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, inner: string) => {
      const value = data[key];
      if (!value) return '';
      return inner.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => data[k] ?? '');
    },
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => data[k] ?? '');
  return out;
}

/** Escape for interpolation into the HTML email body. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The email rendering of one alert, built from the same token data as the
 * WhatsApp message. Deliberately not the WhatsApp template: `*bold*` renders
 * as literal asterisks in a mail client, and email has a subject line and
 * room for a real layout.
 */
export function renderAlertEmail(data: Record<string, string>): {
  subject: string;
  text: string;
  html: string;
} {
  const title = data.title || 'New notice';
  const subject = `${data.categoryEmoji} ${title}`.slice(0, 180);

  const facts: [string, string][] = [
    ['Organization', data.organization],
    ['Published', data.publishedDate],
    ['Deadline', data.deadlineDate],
    ['Urgency', data.urgencyLabel ? `${data.urgencyEmoji} ${data.urgencyLabel}` : ''],
  ];
  const present = facts.filter(([, v]) => v);

  const text = [
    `${data.categoryEmoji} ${data.categoryLabel} alert`,
    '',
    title,
    '',
    ...present.map(([k, v]) => `${k}: ${v}`),
    ...(data.summary ? ['', 'Summary:', data.summary] : []),
    ...(data.keyFacts ? ['', 'Key facts:', data.keyFacts] : []),
    '',
    `Matched your alert "${data.ruleName}" (${data.matchReason}).`,
    '',
    `Read the full notice: ${data.noticeUrl}`,
    `Manage your alerts: ${data.manageUrl}`,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12203a">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <p style="margin:0 0 4px;font-size:13px;color:#5b6b86">${esc(data.categoryEmoji)} ${esc(data.categoryLabel)} alert</p>
    <h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;font-weight:600">${esc(title)}</h1>
    ${present
      .map(
        ([k, v]) =>
          `<p style="margin:0 0 6px;font-size:14px"><span style="color:#5b6b86">${esc(k)}:</span> ${esc(v)}</p>`,
      )
      .join('')}
    ${data.summary ? `<p style="margin:18px 0 0;font-size:14px;line-height:1.6">${esc(data.summary)}</p>` : ''}
    ${
      data.keyFacts
        ? `<ul style="margin:14px 0 0;padding-left:18px;font-size:14px;line-height:1.6">${data.keyFacts
            .split('\n')
            .map((f) => `<li>${esc(f.replace(/^•\s*/, ''))}</li>`)
            .join('')}</ul>`
        : ''
    }
    <p style="margin:22px 0 0">
      <a href="${esc(data.noticeUrl)}" style="display:inline-block;background:#12203a;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:999px;font-size:14px">Read the full notice</a>
    </p>
    <hr style="margin:26px 0 14px;border:0;border-top:1px solid #e6eaf0" />
    <p style="margin:0;font-size:12px;color:#5b6b86">
      Matched your alert <strong>${esc(data.ruleName)}</strong> (${esc(data.matchReason)}).<br />
      <a href="${esc(data.manageUrl)}" style="color:#5b6b86">Manage your alerts</a>
    </p>
  </div>
</body></html>`;

  return { subject, text, html };
}

/** Realistic fixture data for the admin's live preview — no real notice required. */
export function sampleTemplateData(): Record<string, string> {
  return {
    categoryEmoji: '📢',
    categoryLabel: 'Notice',
    title: 'Public Service Commission — Written Exam Schedule for Section Officer (2083)',
    organization: 'Public Service Commission (Lok Sewa Aayog)',
    publishedDate: '5 Sep 2026',
    deadlineDate: '20 Sep 2026',
    urgencyEmoji: '🔴',
    urgencyLabel: 'High urgency',
    summary:
      'The commission has published the written examination schedule and admit-card download instructions for Section Officer candidates. Exams begin 21 Sep 2026 at designated centers across all seven provinces.',
    keyFacts: '• Admit cards downloadable from 12 Sep 2026\n• Exam centers assigned by permanent address\n• Bring citizenship certificate and admit card',
    matchReason: 'category Notice, keyword "exam"',
    ruleName: 'PSC exam alerts',
    noticeUrl: 'https://suchanaai.tech/notices/sample-notice-id',
    manageUrl: 'https://suchanaai.tech/dashboard/alerts',
  };
}
