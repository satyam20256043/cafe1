// Verifies the AI keys in .env actually WORK — not just that they're present.
// The boot banner only checks presence, which is how a silently-truncated key
// looked healthy for a week on the old server. This makes real API calls.
require('dotenv').config({ path: __dirname + '/.env' });

async function checkClaude() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return console.log('CLAUDE: no key set (Gemini fallback would be used)');
  console.log('CLAUDE: key present, length=' + key.length + (key.length < 50 ? '  <-- SUSPICIOUSLY SHORT (real keys ~108 chars)' : ''));
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    const r = await client.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    console.log('CLAUDE: ✅ WORKING — replied:', JSON.stringify(r.content[0].text.trim()));
  } catch (e) {
    console.log('CLAUDE: ❌ FAILED —', e.status || '', e.message);
  }
}

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return console.log('GEMINI: no key set');
  const looksWrong = !key.startsWith('AIza');
  console.log('GEMINI: key present, length=' + key.length + (looksWrong ? '  <-- WRONG FORMAT (real keys start "AIza", ~39 chars)' : ''));
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });
    const r = await model.generateContent('Reply with exactly: OK');
    console.log('GEMINI: ✅ WORKING — replied:', JSON.stringify(r.response.text().trim()));
  } catch (e) {
    console.log('GEMINI: ❌ FAILED —', e.status || '', (e.message || '').split('\n')[0]);
  }
}

(async () => {
  console.log('--- AI key live-call verification ---');
  await checkClaude();
  await checkGemini();
  console.log('--- done ---');
})();
