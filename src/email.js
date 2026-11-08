export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function buildEmail(request, product, config) {
  const name = String(product.name || request.sku).replace(/[\r\n]/g, ' ').slice(0, 200);
  const url = config.publicUrl ? `${config.publicUrl}/?sku=${encodeURIComponent(request.sku)}` : '';
  let price = '';
  if (typeof product.price === 'number' && Number.isFinite(product.price) && product.price >= 0 && /^[A-Z]{3}$/.test(product.currency || '')) {
    try { price = new Intl.NumberFormat('en-GB', { style: 'currency', currency: product.currency }).format(product.price); } catch { /* Currency metadata is optional. */ }
  }
  const e = escapeHtml;
  const text = `Good things come back.\n\n${name} is back in stock.\nSKU: ${request.sku}${price ? `\nPrice: ${price}` : ''}\n\n${url ? `View item: ${url}\n\n` : ''}Availability can change quickly; this alert does not reserve an item.\n\nYou asked for one restock alert for this item. Your request is now complete; no more emails will be sent for this request.\n\nRestock`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your item is back</title></head>
<body style="margin:0;padding:0;background:#f2f4f0;color:#172c2a;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">The wait is over. ${e(name)} is available again.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f4f0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px"><tr><td style="padding:0 8px 24px;font-size:24px;font-weight:bold;letter-spacing:-1px">restock<span style="color:#2b8769">.</span></td></tr>
<tr><td style="background:#ffffff;border:1px solid #dde4dc;border-radius:16px;padding:36px 24px">
<p style="margin:0 0 20px;font-size:11px;font-weight:bold;letter-spacing:2px;color:#287656">THE WAIT IS OVER</p>
<h1 style="margin:0 0 16px;font-size:38px;line-height:1.15;letter-spacing:-1.5px">Good things<br>come back.</h1>
<p style="margin:0 0 28px;font-size:16px;line-height:1.7;color:#61716a">A little good news for your inbox. The item you had your eye on is available again.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7f2;border-radius:10px"><tr><td style="padding:22px">
<p style="margin:0 0 10px;font-size:11px;font-weight:bold;color:#287656;letter-spacing:1px">BACK IN STOCK</p>
<h2 style="margin:0 0 8px;font-size:20px;line-height:1.4">${e(name)}</h2>
<p style="margin:0;color:#68786f;font-size:12px;word-break:break-all">SKU ${e(request.sku)}</p>
${price ? `<p style="margin:14px 0 0;font-size:19px;font-weight:bold">${e(price)}</p>` : ''}
</td></tr></table>
${url ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:24px"><tr><td align="center" style="background:#203b32;border-radius:8px"><a href="${e(url)}" style="display:block;padding:17px 12px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold">Take another look &rarr;</a></td></tr></table>` : ''}
<p style="margin:18px 0 0;font-size:12px;line-height:1.6;text-align:center;color:#6d7972">Worth a look soon. Stock can change, and this isn't a reservation.</p>
</td></tr><tr><td style="padding:24px 16px;text-align:center;font-size:12px;line-height:1.7;color:#778079">You asked for an alert for ${e(request.sku)}.<br>This is your one-time notification. No mailing list, no extra noise.<br><br>restock. &nbsp; Good things, worth the wait.</td></tr></table>
</td></tr></table></body></html>`;
  return { from: config.fromEmail, to: [request.email], subject: `${name} is back in stock`, html, text };
}
