'use strict';
const crypto = require('crypto');

/**
 * Authorize.Net signs every notification with HMAC-SHA512 over the raw body.
 *
 * Verified against the raw bytes, not the parsed object: JSON.parse followed
 * by JSON.stringify does not round-trip byte for byte, and the signature would
 * then fail for reasons that look like a bug in the gateway.
 *
 * No database, no config object, no side effects — so this can be tested on
 * its own, which is the point of it living in its own file.
 */
function verifySignature(rawBody, header, signatureKey = process.env.ANET_SIGNATURE_KEY) {
  if (!signatureKey) throw new Error('ANET_SIGNATURE_KEY is not set');
  if (!header) return false;
  const sent = String(header).replace(/^sha512=/i, '').toLowerCase();
  const expected = crypto
    .createHmac('sha512', Buffer.from(signatureKey, 'hex'))
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(sent, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length check first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifySignature };
