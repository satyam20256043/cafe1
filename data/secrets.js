'use strict';
/**
 * secrets.js — AES-256-GCM encryption for stored OAuth tokens (GB2).
 *
 * encrypt(plaintext)  → 'v1:<iv_b64>:<tag_b64>:<ciphertext_b64>'
 * decrypt(str)        → plaintext string
 *
 * The encryption key comes from process.env.TOKEN_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 * isConfigured()      → true only when the key is exactly 64 hex characters.
 *
 * decrypt() throws on: tamper, wrong key, malformed input.
 * Callers must catch and treat as needs_reconnect — never crash the server.
 *
 * Security rules:
 *  - Never log inputs or outputs.
 *  - Never return the key or ciphertext in an API response.
 *  - Generate a different key per environment:
 *      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const IV_BYTES   = 12;  // 96-bit IV — recommended for GCM
const TAG_BYTES  = 16;  // 128-bit auth tag — GCM default
const VERSION    = 'v1';

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!isConfigured()) throw new Error('TOKEN_ENCRYPTION_KEY is not configured (must be 64 hex chars)');
  return Buffer.from(hex, 'hex');
}

function isConfigured() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || '';
  return /^[0-9a-fA-F]{64}$/.test(hex);
}

/**
 * Encrypt plaintext. Returns a versioned string safe to store in the DB.
 * @param {string} plaintext
 * @returns {string} 'v1:<iv_b64>:<tag_b64>:<ciphertext_b64>'
 */
function encrypt(plaintext) {
  const key  = getKey();
  const iv   = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct   = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a string produced by encrypt(). Throws on any integrity failure.
 * @param {string} str
 * @returns {string} plaintext
 */
function decrypt(str) {
  if (typeof str !== 'string') throw new Error('decrypt: input must be a string');
  const parts = str.split(':');
  // Format: v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
  // The ciphertext part may itself contain ':' (base64 padding), so we join the rest.
  if (parts.length < 4 || parts[0] !== VERSION) throw new Error('decrypt: unrecognised format');
  const iv  = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct  = Buffer.from(parts.slice(3).join(':'), 'base64');
  if (iv.length !== IV_BYTES)  throw new Error('decrypt: bad IV length');
  if (tag.length !== TAG_BYTES) throw new Error('decrypt: bad tag length');
  const key      = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf8');
  } catch (e) {
    throw new Error('decrypt: authentication failed — data may be tampered or key is wrong');
  }
}

module.exports = { encrypt, decrypt, isConfigured };
