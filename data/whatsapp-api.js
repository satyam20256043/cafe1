// ─────────────────────────────────────────────────────────────────────────────
//  whatsapp-api.js — Per-café WhatsApp Cloud API module
//  Uses Meta's official WhatsApp Business Cloud API (no Chrome, no QR scan)
//  Each café has its own phoneNumberId + accessToken stored in businesses.json
// ─────────────────────────────────────────────────────────────────────────────

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

// ── Send a plain text message ────────────────────────────────────────────────
async function sendMessage(phoneNumberId, accessToken, to, text) {
  if (!phoneNumberId || !accessToken) throw new Error('Missing WhatsApp API credentials');
  const cleanTo = String(to).replace(/[^0-9]/g, '');
  try {
    const res = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanTo,
        type: 'text',
        text: { preview_url: false, body: text }
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[WA Cloud API] Send failed:', JSON.stringify(data));
      throw new Error(data?.error?.message || 'Send failed');
    }
    return data;
  } catch (e) {
    console.error('[WA Cloud API] sendMessage error:', e.message);
    throw e;
  }
}

// ── Mark incoming message as read (shows blue ticks) ────────────────────────
async function markAsRead(phoneNumberId, accessToken, messageId) {
  if (!phoneNumberId || !accessToken || !messageId) return;
  try {
    await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      })
    });
  } catch (e) { /* non-critical */ }
}

// ── Send a template message (for proactive notifications) ───────────────────
async function sendTemplate(phoneNumberId, accessToken, to, templateName, langCode, components) {
  if (!phoneNumberId || !accessToken) throw new Error('Missing WhatsApp API credentials');
  const cleanTo = String(to).replace(/[^0-9]/g, '');
  try {
    const res = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'template',
        template: {
          name: templateName,
          language: { code: langCode || 'en' },
          components: components || []
        }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Template send failed');
    return data;
  } catch (e) {
    console.error('[WA Cloud API] sendTemplate error:', e.message);
    throw e;
  }
}

// ── Get phone number info (to verify credentials are valid) ─────────────────
async function verifyCredentials(phoneNumberId, accessToken) {
  try {
    const res = await fetch(`${GRAPH_URL}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (!res.ok) return { valid: false, error: data?.error?.message || 'Invalid credentials' };
    return { valid: true, phone: data.display_phone_number, name: data.verified_name };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

module.exports = { sendMessage, markAsRead, sendTemplate, verifyCredentials };
