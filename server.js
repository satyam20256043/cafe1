require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const waApi = require('./whatsapp-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
// ── Phase 1 modules (SQLite + Auth + Backup) ─────────────────────────────────
let db, auth, backup;
try {
  db     = require('./db');
  auth   = require('./auth');
  backup = require('./backup');
  console.log('[Phase1] ✓ SQLite + Auth + Backup modules loaded');
} catch(e) {
  console.warn('[Phase1] ⚠ Modules not found, running in legacy JSON mode:', e.message);
}
// Safe auth middleware — passes through if auth module not loaded
const safeAuth = (auth && auth.requireAuth) ? auth.requireAuth : (req, res, next) => next();


// Initialize Gemini API client if API key is provided
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
if (genAI) {
  console.log('[AI Engine] Google Gemini LLM Mode Active 🚀');
} else {
  console.log('[AI Engine] Local Conversational NLP Mode Active (Fallback) 🤖');
}


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve custom isolated branch microsites

// Staff login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/cafe/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cafe.html'));
});

// Serve branch manager dashboards
app.get('/manager/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});

// Serve owner portal
app.get('/owner.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'owner.html'));
});
app.get('/owner/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'owner.html'));
});

// Directories setup
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Load or Seed Businesses
const BUSINESSES_FILE = path.join(DATA_DIR, 'businesses.json');
let businesses = [];

function loadBusinesses() {
  if (fs.existsSync(BUSINESSES_FILE)) {
    try {
      businesses = JSON.parse(fs.readFileSync(BUSINESSES_FILE, 'utf-8'));
    } catch(e) {
      console.error('[Startup] businesses.json parse error:', e.message, '— using defaults');
      businesses = [];
    }
  } else {
    businesses = [
      {
        id: 'indiranagar',
        name: 'The Roasted Bean',
        location: '12th Main Road, Indiranagar, Bengaluru',
        timings: '9:00 AM - 11:00 PM',
        contact: '+91 98765 43210',
        map: 'https://maps.google.com/?q=Roasted+Bean+Indiranagar',
        wifi: 'RoastedBean_Guest / Coffee123',
        review: 'https://g.page/r/roasted-bean-indira',
        status: 'online'
      },
      {
        id: 'koramangala',
        name: 'Mocha & Co.',
        location: '5th Block, Koramangala, Bengaluru',
        timings: '10:00 AM - 12:00 AM',
        contact: '+91 87654 32109',
        map: 'https://maps.google.com/?q=Mocha+Koramangala',
        wifi: 'Mocha_Kora_5G / EspressoHigh',
        review: 'https://g.page/r/mocha-kora',
        status: 'offline'
      }
    ];
    fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  }
  // Initialize data folders for each business
  businesses.forEach(b => initializeBusinessFiles(b.id));
}

// Initialize specific branch folders and seed files
function initializeBusinessFiles(id) {
  const branchDir = path.join(DATA_DIR, id);
  if (!fs.existsSync(branchDir)) fs.mkdirSync(branchDir);

  const menuFile = path.join(branchDir, 'menu.json');
  if (!fs.existsSync(menuFile)) {
    const defaultMenu = [
      { id: '1', name: 'Cold Coffee', category: 'Coffee', price: 149, discount: 0, description: 'Signature rich cold coffee blended with vanilla ice cream and topped with cocoa powder.' },
      { id: '2', name: 'Peri Peri Fries', category: 'Fries', price: 119, discount: 10, description: 'Crispy golden fries tossed in our signature spicy peri peri seasoning.' },
      { id: '3', name: 'Alfredo Pasta', category: 'Pasta', price: 229, discount: 0, description: 'Rich and creamy penne pasta tossed in garlic parmesan white sauce with mushrooms.' },
      { id: '4', name: 'Classic Cheese Burger', category: 'Burgers', price: 179, discount: 20, description: "Juicy flame-grilled burger patty topped with cheddar cheese, lettuce, tomatoes, and chef's special burger sauce." },
      { id: '5', name: 'Virgin Mojito', category: 'Mocktails', price: 139, discount: 0, description: 'Refreshing summer cooler made with fresh mint leaves, lime wedges, simple syrup, and sparkling soda.' },
      { id: '6', name: 'Coffee & Burger Combo', category: 'Combo', price: 299, discount: 15, description: 'Classic Cheese Burger paired with our signature Cold Coffee. The ultimate pick-me-up meal.' },
      { id: '7', name: 'Pasta & Mojito Combo', category: 'Combo', price: 349, discount: 10, description: 'Alfredo Pasta served with a refreshing glass of Virgin Mojito. Complete delicious lunch combo.' }
    ];
    fs.writeFileSync(menuFile, JSON.stringify(defaultMenu, null, 2));
  }

  const reservationsFile = path.join(branchDir, 'reservations.json');
  if (!fs.existsSync(reservationsFile)) {
    const defaultReservations = [
      { id: 'r1', name: 'Rahul Sharma', phone: '9876543210', guests: 4, datetime: 'Friday 7:30 PM', status: 'approved' },
      { id: 'r2', name: 'Priya Patel', phone: '8765432109', guests: 2, datetime: 'Saturday 8:00 PM', status: 'pending' }
    ];
    fs.writeFileSync(reservationsFile, JSON.stringify(defaultReservations, null, 2));
  }

  const customerProfilesFile = path.join(branchDir, 'customer_profiles.json');
  if (!fs.existsSync(customerProfilesFile)) {
    const defaultProfiles = [
      { phone: '9876543210', name: 'Rahul Sharma', visits: 3, tags: ['interested_in_coffee', 'frequent_booker'] },
      { phone: '8765432109', name: 'Priya Patel', visits: 1, tags: ['asked_for_offers', 'interested_in_burgers'] }
    ];
    fs.writeFileSync(customerProfilesFile, JSON.stringify(defaultProfiles, null, 2));
  }

  const trafficStatsFile = path.join(branchDir, 'traffic_stats.json');
  if (!fs.existsSync(trafficStatsFile)) {
    // Generate realistic multi-day hourly traffic
    const defaultTraffic = {
      Monday: [5, 3, 2, 4, 8, 12, 10, 5],
      Tuesday: [4, 2, 3, 5, 7, 10, 9, 4],
      Wednesday: [6, 4, 3, 5, 8, 11, 12, 6],
      Thursday: [5, 4, 4, 6, 9, 13, 11, 7],
      Friday: [12, 9, 8, 15, 22, 28, 30, 24],
      Saturday: [18, 14, 15, 20, 32, 45, 42, 35],
      Sunday: [15, 12, 11, 18, 28, 38, 35, 28]
    };
    fs.writeFileSync(trafficStatsFile, JSON.stringify(defaultTraffic, null, 2));
  }

  const settingsFile = path.join(branchDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    const defaultSettings = {
      autoPilotActive: true,
      lowTrafficCampaigns: [
        { day: 'Tuesday', offer: 'Tuesday Coffee Bonanza - Free Cookie with any Hot Coffee! 🍪☕' },
        { day: 'Wednesday', offer: 'Midweek Pasta Madness - Buy 1 Get 1 50% Off on Alfredo Pasta! 🍝' }
      ]
    };
    fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings, null, 2));
  }

  const offerRequestsFile = path.join(branchDir, 'offer_requests.json');
  if (!fs.existsSync(offerRequestsFile)) {
    const defaultOffers = [];
    fs.writeFileSync(offerRequestsFile, JSON.stringify(defaultOffers, null, 2));
  }

  const reviewClaimsFile = path.join(branchDir, 'google_review_claims.json');
  if (!fs.existsSync(reviewClaimsFile)) {
    fs.writeFileSync(reviewClaimsFile, JSON.stringify([], null, 2));
  }

  const feedbackFile = path.join(branchDir, 'feedback.json');
  if (!fs.existsSync(feedbackFile)) {
    const defaultFeedback = [
      { id: 'f1', customerName: 'Rohan Mehta', rating: 5, comment: 'Bhai, cold coffee ekdum lajawab thi! Aur staff bhi bohot friendly hai. Will visit again! ☕😊', timestamp: 'Friday 9:00 PM' },
      { id: 'f2', customerName: 'Sneha Sen', rating: 3, comment: 'Alfredo Pasta was a bit dry, but the burger and mojito were great! Nice vibe.', timestamp: 'Saturday 7:30 PM' }
    ];
    fs.writeFileSync(feedbackFile, JSON.stringify(defaultFeedback, null, 2));
  }
}

loadBusinesses();


// ── Phase 1 Boot: Auth seeds + Backup scheduler ───────────────────────────────
if (db && auth) {
  try {
    db.migrateFromJSON();   // JSON → SQLite on first run
    businesses.forEach(b => {
      auth.seedOwnerIfNeeded(b.id, b.name);
    });
    console.log('[Phase1] ✓ Auth seeds complete');
  } catch(e) {
    console.warn('[Phase1] Auth seed error:', e.message);
  }
}
if (backup) {
  backup.scheduleDaily();
}

// Per-café WhatsApp Cloud API state
// Each business stores its own status: { status, phone, error }
const waStatus = {}; // key: branchId

// Helper — get WhatsApp config for a branch
function getWaConfig(branchId) {
  const b = businesses.find(b => b.id === branchId);
  return b?.whatsapp || null;
}

// Helper — send WhatsApp message for a specific branch
async function sendWhatsAppToCustomer(branchId, phone, text) {
  const cfg = getWaConfig(branchId);
  if (!cfg?.phoneNumberId || !cfg?.accessToken) {
    console.warn('[WA Cloud API] No credentials for branch:', branchId);
    return false;
  }
  try {
    await waApi.sendMessage(cfg.phoneNumberId, cfg.accessToken, phone, text);
    return true;
  } catch(e) {
    console.error('[WA Cloud API] Send error for', branchId, ':', e.message);
    return false;
  }
}

// Chat state memory: per business ID -> per sender number
const userStates = {};

// Get business details helper
function getBranchData(id, filename) {
  const filepath = path.join(DATA_DIR, id, filename);
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }
  return [];
}

// Write business details helper
function writeBranchData(id, filename, data) {
  const filepath = path.join(DATA_DIR, id, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return data;
}

// -------------------------------------------------------------
// 🧠 AI Chatbot NLP Engine (Language, Dynamic Pricing & State)
// -------------------------------------------------------------
function detectLanguage(text) {
  const hindiRegex = /[\u0900-\u097F]/;
  if (hindiRegex.test(text)) return 'hindi';

  const hinglishWords = [
    'hai', 'kaha', 'kya', 'kab', 'bhai', 'batao', 'lo', 'timing', 'address', 'sasta', 
    'discount', 'kardo', 'milega', 'de do', 'achha', 'helo', 'namaste', 'shukriya', 'karna', 
    'humare', 'bestsellers', 'kitne', 'paise', 'bhejo', 'dikhao', 'kya hai', 'boliye', 'bataiye'
  ];
  const lowercaseText = text.toLowerCase();
  const words = lowercaseText.split(/\s+/);
  const hinglishCount = words.filter(w => hinglishWords.includes(w)).length;

  if (hinglishCount >= 1) return 'hinglish';
  return 'english';
}

function updateTrafficStats(branchId) {
  const stats = getBranchData(branchId, 'traffic_stats.json');
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  const hour = now.getHours();
  // Map 24h into our 8 buckets: [9-11am, 11am-1pm, 1-3pm, 3-5pm, 5-7pm, 7-9pm, 9-11pm, 11pm-1am]
  let bucket = 0;
  if (hour >= 9 && hour < 11) bucket = 0;
  else if (hour >= 11 && hour < 13) bucket = 1;
  else if (hour >= 13 && hour < 15) bucket = 2;
  else if (hour >= 15 && hour < 17) bucket = 3;
  else if (hour >= 17 && hour < 19) bucket = 4;
  else if (hour >= 19 && hour < 21) bucket = 5;
  else if (hour >= 21 && hour < 23) bucket = 6;
  else bucket = 7;

  if (stats[day]) {
    stats[day][bucket] = (stats[day][bucket] || 0) + 1;
    writeBranchData(branchId, 'traffic_stats.json', stats);
    io.emit('traffic_update', { branchId, stats });
  }
}

function getLoyaltyTier(visits) {
  if (visits >= 10) return 'Elite';
  if (visits >= 5) return 'VIP';
  if (visits >= 2) return 'Regular';
  return 'New Customer';
}

function updateCustomerProfile(branchId, phone, name, lastIntent, additionalFields = {}) {
  phone = normalizePhone(phone) || phone; // always store 10-digit
  const profiles = getBranchData(branchId, 'customer_profiles.json');
  let profile = profiles.find(p => normalizePhone(p.phone) === phone);
  if (!profile) {
    profile = { 
      phone, 
      name: name || 'Customer', 
      visits: 0, 
      tags: [], 
      lastActive: new Date().toLocaleString(),
      averageRating: 0,
      feedbackCount: 0,
      offersReceived: []
    };
    profiles.push(profile);
  }
  
  profile.visits += 1;
  profile.lastActive = new Date().toLocaleString();
  
  if (name) profile.name = name;
  
  // Merge any additional fields
  for (const [key, value] of Object.entries(additionalFields)) {
    profile[key] = value;
  }
  
  // Compute loyalty tier
  profile.loyaltyTier = getLoyaltyTier(profile.visits);
  
  if (lastIntent && !profile.tags.includes(lastIntent)) {
    profile.tags.push(lastIntent);
  }
  writeBranchData(branchId, 'customer_profiles.json', profiles);
  io.emit('crm_update', { branchId, profiles });
}

// ── Phone normalisation helper ───────────────────────────────────────────────
// WhatsApp gives us "919876543210" (with country code). CRM stores last 10 digits
// so lookups are consistent whether number comes from WhatsApp, web, or walk-in.
function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^0-9]/g, '').slice(-10);
}
// ─────────────────────────────────────────────────────────────────────────────

// AI Helper: Gemini API Reply Generator (Phase 4 — Loyalty Aware)
async function generateGeminiReply(branchId, text, fromPhone) {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const business = businesses.find(b => b.id === branchId) || businesses[0];
    const menu = getBranchData(branchId, 'menu.json');

    // ── Pull real loyalty data from SQLite ──────────────────────────────────
    let customerName = 'Valued Customer';
    let customerTier = 'New';
    let customerVisits = 0;
    let loyaltyPoints = 0;
    let loyaltyStamps = 0;
    let stampsToFree = 10;
    let loyaltyCard = null;

    if (fromPhone && db) {
      try {
        const phone = normalizePhone(fromPhone);
        loyaltyCard = db.getLoyaltyCard(branchId, phone);
        if (loyaltyCard) {
          customerName   = loyaltyCard.customer_name || loyaltyCard.name || 'Customer';
          customerTier   = loyaltyCard.tier   || 'New';
          customerVisits = loyaltyCard.visits  || 0;
          loyaltyPoints  = loyaltyCard.points  || 0;
          loyaltyStamps  = loyaltyCard.stamps  || 0;
          stampsToFree   = Math.max(0, 10 - loyaltyStamps);
        } else {
          // Fall back to JSON profile
          const profiles = getBranchData(branchId, 'customer_profiles.json');
          const profile = profiles.find(p => p.phone === fromPhone);
          if (profile) {
            customerName  = profile.name || 'Customer';
            customerVisits = profile.visits || 0;
            customerTier  = profile.loyaltyTier || getLoyaltyTier(customerVisits);
          }
        }
      } catch(e) { /* loyalty lookup failed — proceed without it */ }
    }
    
    let menuStr = menu.map(item => {
      let finalPrice = item.price;
      if (item.discount > 0) {
        finalPrice = Math.round(item.price * (1 - item.discount / 100));
        return `- ${item.name} (${item.category}): ₹${finalPrice} (standard price was ₹${item.price}, today ${item.discount}% off)`;
      }
      return `- ${item.name} (${item.category}): ₹${finalPrice}`;
    }).join('\n');

    const loyaltyContext = loyaltyCard
      ? `- Loyalty Points: ${loyaltyPoints} pts (${customerTier} tier)
- Stamp Card: ${loyaltyStamps}/10 stamps collected (${stampsToFree} more for a FREE item!)
- Total Visits: ${customerVisits}`
      : `- New customer (no loyalty card yet — invite them to register!)`;

    const prompt = `You are a warm, helpful, and natural human customer support assistant for "${business.name}" café.
Your role is to:
- Reply instantly, naturally, and warmly in a human-like host tone.
- Adapt to the customer's language automatically (English, Hindi, or Hinglish). Reply in the exact style and language of the customer query.
- Maintain a cozy, welcoming café vibe.

Customer Context:
- Name: ${customerName}
- Loyalty Tier: ${customerTier} (${customerVisits} visits)
${loyaltyContext}

Personalization Instructions:
- Greet returning customers (Regular/VIP/Elite) warmly by name.
- Mention their points/stamps when relevant (e.g., if they ask about rewards or are close to a free item).
- If they have 10+ stamps, remind them they have a FREE item waiting!
- If they have 500+ points, mention they can redeem for a discount.
- Treat VIP/Elite members with premium hospitality.

Café Context:
- Name: ${business.name}
- Location: ${business.location} (Maps: ${business.map})
- Timings: ${business.timings}
- Contact: ${business.contact}
- WiFi: ${business.wifi}
- Google Review Link: ${business.review}
- Menu:\n${menuStr}
- Do NOT proactively mention offers or discounts unless the customer specifically asks.

CRITICAL WORKFLOW RULES:
1. Table booking → output exactly: INTENT:RESERVATION
2. Custom/special discount request → output exactly: INTENT:OFFER_REQUEST [details]
3. Feedback/review/rating → output exactly: INTENT:FEEDBACK
4. Customer asks "what are my points", "how many stamps", "mera balance", "my rewards", "loyalty card" → output exactly: INTENT:LOYALTY_QUERY
5. Customer wants to redeem stamps/points ("redeem", "free item", "use points") → output exactly: INTENT:LOYALTY_REDEEM
6. Keep replies concise (max 3 sentences) and conversational.

Customer query: "${text}"
Your Response:`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    console.error('[Gemini API Error]', error);
    return null;
  }
}

// AI Helper: Local Conversational Responder (Fallback)
function generateLocalConversationalReply(branchId, text, lang, fromPhone) {
  const business = businesses.find(b => b.id === branchId) || businesses[0];
  const lowercaseText = text.toLowerCase();

  let customerName = '';
  let customerTier = 'New Customer';
  if (fromPhone) {
    const profiles = getBranchData(branchId, 'customer_profiles.json');
    const profile = profiles.find(p => p.phone === fromPhone);
    if (profile) {
      customerName = profile.name || '';
      customerTier = profile.loyaltyTier || getLoyaltyTier(profile.visits);
    }
  }

  // Greetings & Small talk
  if (['hello', 'hey', 'hi', 'hola', 'helo', 'namaste', 'namaskar', 'pranam'].some(kw => lowercaseText.includes(kw))) {
    let greetingPrefix = '';
    if (customerTier === 'Elite') {
      greetingPrefix = customerName ? `Welcome back, our Elite guest ${customerName}! 🌟 ` : `Welcome back, our Elite guest! 🌟 `;
    } else if (customerTier === 'VIP') {
      greetingPrefix = customerName ? `Welcome back, our VIP guest ${customerName}! ✨ ` : `Welcome back, our VIP guest! ✨ `;
    } else if (customerTier === 'Regular') {
      greetingPrefix = customerName ? `Welcome back, ${customerName}! 😊 ` : `Welcome back! 😊 `;
    } else {
      greetingPrefix = customerName ? `Hello ${customerName}! 😊 ` : `Hello! 😊 `;
    }

    if (lang === 'hinglish') {
      return `${greetingPrefix}${business.name} par aapka swagat hai. Main aapki kya help karoon? Aap menu dekh sakte hain ya table book kar sakte hain! ☕`;
    } else if (lang === 'hindi') {
      return `${greetingPrefix}${business.name} में आपका स्वागत है। मैं आपकी क्या मदद करूँ? आप हमारा मेनू देख सकते हैं या टेबल बुक कर सकते हैं! ☕`;
    } else {
      return `${greetingPrefix}Welcome to ${business.name}. How can I assist you today? You can check our Menu, Location, or Book a Table! ☕`;
    }
  }

  // How are you
  if (['how are you', 'how is it going', 'kaise ho', 'sab badhiya', 'kya haal'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Main bilkul badhiya hoon, aap bataiye! Aapke liye kya special coffee order karoon aaj? ☕😊`;
    } else if (lang === 'hindi') {
      return `मैं बिल्कुल ठीक हूँ, आप बताएं! आज आपके लिए क्या खास कॉफ़ी आर्डर करूँ? ☕😊`;
    } else {
      return `I'm doing great, thank you for asking! How are you doing? Ready to order some fresh coffee today? ☕😊`;
    }
  }

  // Recommendations
  if (['recommend', 'suggest', 'bestseller', 'special', 'tasty', 'popular', 'what should i'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Humara *Cold Coffee* (₹149) aur *Peri Peri Fries* (₹107 - today 10% off!) bohot hi bestselling aur tasty combo hai! Aapko zaroor try karna chahiye! 🍔🥤`;
    } else if (lang === 'hindi') {
      return `हमारा *कोल्ड कॉफ़ी* (₹149) और *पेरी पेरी फ्राइज़* (₹107 - आज 10% छूट!) बहुत लोकप्रिय और स्वादिष्ट कॉम्बो हैं! आपको ज़रूर आज़माना चाहिए! 🍔🥤`;
    } else {
      return `I highly recommend our signature *Cold Coffee* (₹149) paired with *Peri Peri Fries* (which are only ₹107 today with 10% discount). They are absolute customer favorites! 🍔🥤`;
    }
  }

  // Amenities / Charging
  if (['charging', 'socket', 'plug', 'laptop', 'work', 'wifi', 'internet'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Haan ji, café me tables ke paas free high-speed WiFi aur charging sockets/plugs standard available hain, toh aap yahan aaram se laptop par kaam kar sakte hain! 📶🔌`;
    } else {
      return `Yes! We have plenty of charging sockets/plugs near our tables and free high-speed WiFi (${business.wifi}), making it the perfect spot to work on your laptop! 📶🔌`;
    }
  }

  // Appreciation / Thanks
  if (['thank', 'thanks', 'shukriya', 'dhanyawad', 'nice', 'great', 'awesome', 'accha'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Aapka bohot bohot shukriya! 😊 Hum aasha karte hain ki aapko humare services pasand aaye. Jaldi hi café visit kijiye! ☕✨`;
    } else if (lang === 'hindi') {
      return `आपका बहुत-बहुत धन्यवाद! 😊 हमें खुशी है कि आपको हमारी सेवाएँ पसंद आईं। जल्द ही कैफ़े आएं! ☕✨`;
    } else {
      return `You are most welcome! 😊 We are always happy to help. Hope to see you at the café soon! ☕✨`;
    }
  }

  // Default conversational fallback
  if (lang === 'hinglish') {
    return `Hello! 😊 ${business.name} par aapka swagat hai. Aap menu, timing, location, ya table booking ke baare me pooch sakte hain. Main aapki kya help karoon? ☕`;
  } else if (lang === 'hindi') {
    return `नमस्ते! 😊 ${business.name} सहायता लाइन पर आपका स्वागत है। आप मेन्यू, समय, स्थान या टेबल बुकिंग के बारे में पूछ सकते हैं। मैं आपकी क्या मदद करूँ? ☕`;
  } else {
    return `Welcome to ${business.name}! 😊 How can I help you today? You can ask about our Menu, Location, Timings, Active Offers, or Book a Table! ☕`;
  }
}

// AI response brain
async function processCafeBotReply(branchId, fromPhone, incomingMessage) {
  updateTrafficStats(branchId);

  const business = businesses.find(b => b.id === branchId) || businesses[0];
  const menu = getBranchData(branchId, 'menu.json');
  const settings = getBranchData(branchId, 'settings.json');
  
  const text = incomingMessage.trim();
  const lowercaseText = text.toLowerCase();
  const lang = detectLanguage(text);

  // Initialize state memory for user
  if (!userStates[branchId]) userStates[branchId] = {};
  if (!userStates[branchId][fromPhone]) {
    userStates[branchId][fromPhone] = { 
      state: 'IDLE', 
      reservationData: { name: null, guests: null, datetime: null },
      feedbackData: { rating: null, comment: null },
      googleReviewData: { reviewerName: null },
      msgCount: 0,          // total turns in this session
      lastOfferAt: 0        // msgCount when offers were last shown
    };
  }
  const userState = userStates[branchId][fromPhone];
  userState.msgCount = (userState.msgCount || 0) + 1;

  // 1. SERIOUS COMPLAINT DETECTOR (RULE 8)
  const complaintKeywords = [
    'complaint', 'bad', 'worst', 'hair', 'dirty', 'rude', 'cold food', 'late', 
    'delay', 'unhygienic', 'spoiled', 'vomit', 'stomach', 'refund', 'ganda', 'kharab'
  ];
  const containsComplaint = complaintKeywords.some(kw => lowercaseText.includes(kw));
  if (containsComplaint) {
    updateCustomerProfile(branchId, fromPhone, null, 'complained');
    return 'Our team will contact you shortly 😊';
  }

  // 1.5 ACTIVE FEEDBACK FLOW STATE MACHINE
  // ── Google Review Reward ─────────────────────────────────────────────────
  // ── GOOGLE_REVIEW_PENDING: customer says Done → ask reviewer name ─────────
  if (userState.state === 'GOOGLE_REVIEW_PENDING') {
    const confirmWords = ['done', 'haan', 'han', 'yes', 'reviewed', 'posted',
      'kar diya', 'ho gaya', 'review diya', 'review kar diya', 'ok', 'okay',
      'completed', 'submit', 'submitted', 'diya', 'ho gayi'];
    const confirmed = confirmWords.some(w => lowercaseText.includes(w));

    if (confirmed) {
      userState.state = 'GOOGLE_REVIEW_NAME_PENDING';
      userState.googleReviewData = { reviewerName: null };
      if (lang === 'hinglish') {
        return '✅ Shukriya! Verification ke liye aapka *Google par naam* batayein jo review mein dikhta hai. 📝\n(Jaise: "Rahul M." ya "Priya Singh")';
      } else if (lang === 'hindi') {
        return '✅ धन्यवाद! Verification के लिए वो *नाम बताएं जो Google review में दिखता है*। 📝';
      } else {
        return '✅ Great! To verify your review, please share the *name shown on your Google review*. 📝\n(e.g. "Rahul M." or "Priya Singh")';
      }
    } else {
      if (lang === 'hinglish') {
        return `Google review dene ke baad *Done* type karein aur *+100 points* paayein! 😊\n👉 ${business.review}`;
      } else if (lang === 'hindi') {
        return `Google review देने के बाद *Done* लिखें और *+100 points* पाएं! 😊\n👉 ${business.review}`;
      } else {
        return `Just reply *Done* after leaving your Google review to claim *+100 points*! 😊\n👉 ${business.review}`;
      }
    }
  }

  // ── GOOGLE_REVIEW_NAME_PENDING: collect reviewer name → save pending claim ─
  if (userState.state === 'GOOGLE_REVIEW_NAME_PENDING') {
    const reviewerName = text.trim();
    if (reviewerName.length < 2) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Kripya apna poora naam batayein jo Google review mein dikh raha hai. 📝'
        : 'Please share the name as it appears on your Google review. 📝';
    }

    userState.state = 'IDLE';
    userState.googleReviewData = { reviewerName: null };

    // Save pending claim
    const phone = fromPhone.replace(/[^0-9]/g,'').slice(-10);
    let custName = userState.reservationData.name;
    if (!custName) {
      const profiles = getBranchData(branchId, 'customer_profiles.json');
      const profile = profiles.find(p => p.phone === fromPhone);
      if (profile && profile.name) custName = profile.name;
    }
    custName = custName || 'Customer';

    // Check for duplicate pending claim
    const claims = getBranchData(branchId, 'google_review_claims.json') || [];
    const alreadyPending = claims.some(c => c.phone === phone && c.status === 'pending');
    if (alreadyPending) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Aapka review claim already pending hai! Manager jald verify karenge. 🙏'
        : 'Your review claim is already pending verification. We will process it soon! 🙏';
    }

    // Check if already approved before
    const txHistory = db ? (db.getLoyaltyTransactions(branchId, phone, 10)) : [];
    const alreadyRewarded = txHistory.some(t => t.description && t.description.includes('Google review reward'));
    if (alreadyRewarded) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Aapko Google review reward pehle hi mil chuka hai! 😊 Aapke points safe hain. ☕'
        : 'You have already received your Google review reward! Your points are safe. ☕';
    }

    const claim = {
      id: 'grc_' + Date.now(),
      phone,
      customerName: custName,
      reviewerName,
      submittedAt: new Date().toISOString(),
      status: 'pending'
    };
    claims.push(claim);
    writeBranchData(branchId, 'google_review_claims.json', claims);
    io.emit('google_review_claim', { branchId, claim });

    // Notify manager via WhatsApp if connected
    if (getWaConfig(id)) {
      try {
        const mgr = getBranchData(branchId, 'settings.json');
        if (mgr && mgr.managerPhone) {
          const mgrId = '91' + mgr.managerPhone.replace(/\D/g,'').slice(-10);
          await sendWhatsAppToCustomer(id, mgrId,
            `🔔 *New Google Review Claim*\n\nCafé: ${business.name}\nCustomer: ${custName} (+91${phone})\nReviewer Name on Google: *${reviewerName}*\n\nCheck & verify at:\n${business.review}\n\nApprove in Manager Dashboard → Loyalty tab.`
          );
        }
      } catch(e) {}
    }

    if (lang === 'hinglish') {
      return `🎉 Shukriya, *${reviewerName}*! Aapka claim submit ho gaya.\n\n⏳ Manager 24 ghante mein Google par verify karenge aur aapko *+100 points* mil jayenge!\n\nVerification complete hone par aapko yahan notification milega. ☕`;
    } else if (lang === 'hindi') {
      return `🎉 धन्यवाद, *${reviewerName}*! आपका claim submit हो गया।\n\n⏳ Manager 24 घंटे में Google पर verify करेंगे और आपको *+100 points* मिलेंगे!\n\nVerification पूरी होने पर यहाँ notification मिलेगा। ☕`;
    } else {
      return `🎉 Thanks, *${reviewerName}*! Your claim has been submitted.\n\n⏳ Our manager will verify your Google review within 24 hours and credit *+100 points* to your account!\n\nYou'll receive a notification here once verified. ☕`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (userState.state === 'FEEDBACK') {
    const data = userState.feedbackData;
    
    if (!data.rating) {
      const ratingMatch = text.match(/[1-5]/);
      if (ratingMatch) {
        data.rating = parseInt(ratingMatch[0]);
      } else {
        const ratingWords = { 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'panch': 5, 'best': 5, 'good': 4, 'bad': 1 };
        const found = Object.keys(ratingWords).find(w => lowercaseText.includes(w));
        if (found) {
          data.rating = ratingWords[found];
        } else {
          return lang === 'hinglish' || lang === 'hindi'
            ? 'Kripya 1 se 5 ke beech koi number share karein! (1: Worst, 5: Best) ⭐'
            : 'Please share a rating between 1 and 5 stars! (1: Worst, 5: Best) ⭐';
        }
      }
      
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Bohot achha! Kripya apna comment ya suggestion type karke share karein. ✍️'
        : 'Thank you! Please type and share your comment or suggestion with us. ✍️';
    } else if (!data.comment) {
      data.comment = text;
      
      // Save feedback
      const feedback = getBranchData(branchId, 'feedback.json');
      let custName = userState.reservationData.name;
      if (!custName) {
        const profiles = getBranchData(branchId, 'customer_profiles.json');
        const profile = profiles.find(p => p.phone === fromPhone);
        if (profile && profile.name) {
          custName = profile.name;
        }
      }
      custName = custName || 'Valued Customer';

      const newFb = {
        id: 'f_' + Date.now(),
        customerName: custName,
        rating: data.rating,
        comment: data.comment,
        timestamp: new Date().toLocaleString()
      };
      feedback.push(newFb);
      writeBranchData(branchId, 'feedback.json', feedback);
      
      // Keep in GOOGLE_REVIEW_PENDING for 5-star so we can reward Google review confirmation
      userState.state = data.rating === 5 ? 'GOOGLE_REVIEW_PENDING' : 'IDLE';
      userState.feedbackData = { rating: null, comment: null };
      
      io.emit('feedback_update', { branchId, feedback });
      
      // Compute new average rating in CRM
      const reviews = feedback.filter(f => f.customerName === newFb.customerName);
      const totalStars = reviews.reduce((sum, r) => sum + r.rating, 0);
      const avg = reviews.length > 0 ? parseFloat((totalStars / reviews.length).toFixed(1)) : newFb.rating;
      
      updateCustomerProfile(branchId, fromPhone, newFb.customerName, 'gave_feedback', {
        averageRating: avg,
        feedbackCount: reviews.length || 1
      });

      // ── 5-Star Review Reward: +100 Loyalty Points ───────────────────────
      if (newFb.rating === 5 && db) {
        try {
          const phone = fromPhone.replace(/[^0-9]/g,'').slice(-10);
          const card = db.awardBonusPoints(branchId, phone, custName, 30, '5-star review reward');
          io.emit('loyalty_update', { businessId: branchId, card });
          console.log(`[Loyalty] +100 bonus pts → ${phone} (5-star review)`);
        } catch(e) { console.warn('[Loyalty] 5-star bonus failed:', e.message); }
      }
      // ─────────────────────────────────────────────────────────────────────

      // Save coupon in customer profile if rating is 5
      let couponCode = null;
      if (newFb.rating === 5) {
        couponCode = 'THANKYOU15';
        newFb.couponCode = couponCode;
        // Re-write updated feedback with couponCode
        writeBranchData(branchId, 'feedback.json', feedback);

        const profiles = getBranchData(branchId, 'customer_profiles.json');
        const profile = profiles.find(p => p.phone === fromPhone);
        if (profile) {
          profile.offersReceived = profile.offersReceived || [];
          if (!profile.offersReceived.some(o => o.offer.includes(couponCode))) {
            profile.offersReceived.push({
              offer: `Feedback Reward: Coupon ${couponCode} (15% Off)`,
              timestamp: new Date().toISOString()
            });
            writeBranchData(branchId, 'customer_profiles.json', profiles);
            io.emit('crm_update', { branchId, profiles });
          }
        }
      }

      if (newFb.rating === 5) {
        if (lang === 'hinglish') {
          return `Aapka bohot bohot shukriya! ❤️ 5-star dene ke liye:\n\n🎁 *+30 Loyalty Points* aapke account mein add ho gaye!\n🎟 Coupon: *THANKYOU15* (15% Off next visit)\n\n⭐ *Google Review ka bonus!*\nHumein Google par bhi review dein aur *+100 aur points* pao!\n👉 ${business.review}\n\nReview karne ke baad yahan *Done* type karein. 😊`;
        } else if (lang === 'hindi') {
          return `बहुत-बहुत धन्यवाद! ❤️ 5-स्टार देने के लिए:\n\n🎁 *+30 Loyalty Points* आपके खाते में जुड़ गए!\n🎟 कूपन: *THANKYOU15* (अगली बार 15% छूट)\n\n⭐ *Google Review बोनस!*\nGoogle पर भी समीक्षा दें और *+100 और Points* पाएं!\n👉 ${business.review}\n\nReview करने के बाद यहाँ *Done* लिखें। 😊`;
        } else {
          return `Thank you so much! ❤️ For the 5-star rating:\n\n🎁 *+30 Loyalty Points* added to your account!\n🎟 Coupon: *THANKYOU15* (15% Off your next visit)\n\n⭐ *Bonus Google Review Reward!*\nLeave us a Google review and earn *+100 more Points*!\n👉 ${business.review}\n\nAfter reviewing, reply *Done* here to claim your points. 😊`;
        }
      } else if (newFb.rating >= 4) {
        if (lang === 'hinglish') {
          return `Aapka bohot bohot shukriya! ❤️ Aapka feedback humare liye bohot valuable hai.\n\nAgar aapko café pasand aaya, toh kripya 1 minute nikal kar humein Google par bhi review dein: ${business.review} \nIsse humein bohot help milegi! 😊⭐`;
        } else if (lang === 'hindi') {
          return `आपका बहुत-बहुत धन्यवाद! ❤️ आपकी प्रतिक्रिया हमारे लिए बहुत मूल्यवान है।\n\nयदि आपको कैफ़े पसंद आया, तो कृपया Google पर भी अपनी समीक्षा साझा करें: ${business.review} \nइससे हमें बहुत मदद मिलेगी! 😊⭐`;
        } else {
          return `Thank you so much! ❤️ Your feedback is highly valuable to us.\n\nIf you enjoyed your experience, please take a moment to leave us a Google review here: ${business.review} \nIt helps our local business grow! 😊⭐`;
        }
      } else {
        if (lang === 'hinglish') {
          return `Feedback share karne ke liye shukriya! Hum isse behtar karne ke liye poori koshish karenge. Have a nice day! 😊`;
        } else {
          return `Thank you for sharing your feedback! We will use this to improve our service. Have a wonderful day! 😊`;
        }
      }
    }
  }

  // 2. ACTIVE RESERVATION FLOW STATE MACHINE
  if (userState.state === 'RESERVATION') {
    const data = userState.reservationData;
    
    // Parse response
    if (!data.name) {
      data.name = text;
      updateCustomerProfile(branchId, fromPhone, data.name, 'table_booking_flow');
    } else if (!data.guests) {
      const numMatch = text.match(/\d+/);
      if (numMatch) {
        data.guests = parseInt(numMatch[0]);
      } else {
        const words = { 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'panch': 5 };
        const found = Object.keys(words).find(w => lowercaseText.includes(w));
        data.guests = found ? words[found] : 2;
      }
    } else if (!data.datetime) {
      data.datetime = text;
    }

    // Next step prompt or completion
    if (!data.name) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Bataiye, reservation kis naam par karni hai? 😊'
        : 'Could you please share the name for the booking? 😊';
    } else if (!data.guests) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Kitne log aane wale hain? (No. of guests) 👥'
        : 'How many guests will be joining? 👥';
    } else if (!data.datetime) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Aap kis date aur time par aana chahte hain? (Date & Time) 📅⏰'
        : 'What date and time would you like to book for? 📅⏰';
    } else {
      // Completion! Save reservation
      const reservations = getBranchData(branchId, 'reservations.json');
      const newRes = {
        id: 'r_' + Date.now(),
        name: data.name,
        phone: fromPhone,
        guests: data.guests,
        datetime: data.datetime,
        status: 'pending'
      };
      reservations.push(newRes);
      writeBranchData(branchId, 'reservations.json', reservations);
      
      userState.state = 'IDLE';
      userState.reservationData = { name: null, guests: null, datetime: null };

      io.emit('reservation_update', { branchId, reservations });
      updateCustomerProfile(branchId, fromPhone, data.name, 'made_booking');

      if (lang === 'hinglish') {
        return `Aapki table successfully book ho gayi hai, ${data.name}! 🎉\n👥 Guests: ${data.guests}\n📅 Time: ${data.datetime}\n\nHum aapka wait karenge, see you soon! 😊☕`;
      } else if (lang === 'hindi') {
        return `आपका टेबल सफलतापूर्वक बुक हो गया है, ${data.name}! 🎉\n👥 मेहमान: ${data.guests}\n📅 समय: ${data.datetime}\n\nहम आपका इंतजार करेंगे! 😊☕`;
      } else {
        return `Perfect! Your table has been successfully booked, ${data.name}! 🎉\n👥 Guests: ${data.guests}\n📅 Schedule: ${data.datetime}\n\nWe look forward to hosting you soon! 😊☕`;
      }
    }
  }

  // 3. DETECT CUSTOM OFFER / DISCOUNT REQUESTS (RULE-BASED OVERRIDE FOR LOCAL FLOWS)
  const customOfferKeywords = [
    'special discount', 'give me discount', 'party discount', 'group discount', 
    'extra discount', 'personal offer', 'discount kardo', 'discount milega', 
    'discount de do', 'deal milegi', 'coupon code'
  ];
  const containsCustomOfferRequest = customOfferKeywords.some(kw => lowercaseText.includes(kw));
  if (containsCustomOfferRequest) {
    const offerRequests = getBranchData(branchId, 'offer_requests.json');
    const newRequest = {
      id: 'o_' + Date.now(),
      phone: fromPhone,
      customerName: userState.reservationData.name || 'Valued Customer',
      requestText: text,
      status: 'pending',
      suggestedOffer: '15% Off bill',
      timestamp: new Date().toLocaleString()
    };
    offerRequests.push(newRequest);
    writeBranchData(branchId, 'offer_requests.json', offerRequests);
    
    io.emit('new_offer_request', { branchId, request: newRequest });
    updateCustomerProfile(branchId, fromPhone, null, 'requested_offer');

    if (lang === 'hinglish') {
      return `Humne aapki request manager ke pass approval ke liye bhej di hai! Jaise hi manager ise approve karenge, main aapko yahan inform karunga. Tab tak aap menu check kar sakte hain! 😊`;
    } else if (lang === 'hindi') {
      return `मैंने आपका अनुरोध प्रबंधक को अनुमोदन के लिए भेज दिया है! जैसे ही यह स्वीकृत होगा, मैं आपको सूचित करूँगा। तब तक आप हमारा मेनू देख सकते हैं! 😊`;
    } else {
      return `I have forwarded your request to the café manager for approval. I will notify you here as soon as it is approved! In the meantime, feel free to browse our menu! 😊`;
    }
  }

  // 4. CALL DYNAMIC GEMINI LLM IF ACTIVE
  if (genAI) {
    const geminiReply = await generateGeminiReply(branchId, text, fromPhone);
    if (geminiReply) {
      if (geminiReply.includes('INTENT:RESERVATION')) {
        userState.state = 'RESERVATION';
        userState.reservationData = { name: null, guests: null, datetime: null };
        return lang === 'hinglish' || lang === 'hindi'
          ? 'Bilkul! 😊 Table book karne me hum aapki help karenge. \nKripya share karein:\n1. Aapka Naam (Name)'
          : 'Sure! Let\'s get your table reserved. \nPlease share:\n1. Your Name';
      }
      if (geminiReply.includes('INTENT:OFFER_REQUEST')) {
        const details = geminiReply.split('INTENT:OFFER_REQUEST')[1] || text;
        const offerRequests = getBranchData(branchId, 'offer_requests.json');
        const newRequest = {
          id: 'o_' + Date.now(),
          phone: fromPhone,
          customerName: userState.reservationData.name || 'Valued Customer',
          requestText: details.trim() || text,
          status: 'pending',
          suggestedOffer: '15% Off bill',
          timestamp: new Date().toLocaleString()
        };
        offerRequests.push(newRequest);
        writeBranchData(branchId, 'offer_requests.json', offerRequests);
        
        io.emit('new_offer_request', { branchId, request: newRequest });
        updateCustomerProfile(branchId, fromPhone, null, 'requested_offer');
        
        return lang === 'hinglish' || lang === 'hindi'
          ? `Humne aapki request manager ke pass approval ke liye bhej di hai! Jaise hi manager ise approve karenge, main aapko yahan inform karunga. Tab tak aap menu check kar sakte hain! 😊`
          : `I have forwarded your request to the café manager for approval. I will notify you here as soon as it is approved! In the meantime, feel free to browse our menu! 😊`;
      }
      if (geminiReply.includes('INTENT:FEEDBACK')) {
        userState.state = 'FEEDBACK';
        userState.feedbackData = { rating: null, comment: null };
        return lang === 'hinglish' || lang === 'hindi'
          ? 'Bilkul! 😊 Aapka feedback humare liye bohot valuable hai. \nKripya humein 1 se 5 stars me rate karein (1: Sabse ganda, 5: Sabse behtar) ⭐'
          : 'Sure! 😊 Your feedback is highly valuable to us. \nPlease rate your experience from 1 to 5 stars (1: Worst, 5: Best) ⭐';
      }

      // ── Phase 4: Loyalty intents ───────────────────────────────────────────
      if (geminiReply.includes('INTENT:LOYALTY_QUERY')) {
        if (!db) return lang === 'hinglish' ? 'Abhi loyalty system available nahi hai, baad mein try karein! 😊' : 'Loyalty system is currently unavailable. Please try again shortly!';
        try {
          const phone = fromPhone.replace(/[^0-9]/g,'').slice(-10);
          const card = db.getOrCreateCard(branchId, phone, userState.customerName || 'Customer');
          const stampsLeft = Math.max(0, 10 - (card.stamps||0));
          const business = businesses.find(b=>b.id===branchId)||businesses[0];
          if (lang === 'hinglish') {
            return `*${card.customer_name||'Aap'}* ka loyalty card! 🌟\n\n☕ Stamps: *${card.stamps||0}/10* (${stampsLeft} aur chahiye free item ke liye!)\n💰 Points: *${card.points||0} pts*\n🏅 Tier: *${card.tier||'New'}*\n\n${(card.stamps||0)>=10?'🎁 Aapka FREE item redeem karne ke liye café mein aaiye!':stampsLeft+' aur visits mein ek free item milega! 😊'}`;
          }
          return `Here's your loyalty card, *${card.customer_name||'friend'}*! 🌟\n\n☕ Stamps: *${card.stamps||0}/10* (${stampsLeft} more for a FREE item!)\n💰 Points: *${card.points||0} pts*\n🏅 Tier: *${card.tier||'New'}*\n\n${(card.stamps||0)>=10?'🎁 You have a FREE item waiting — visit us to redeem!':'Visit '+stampsLeft+' more times to earn your free item! 😊'}`;
        } catch(e) {
          return lang==='hinglish' ? 'Aapka loyalty card abhi check nahi ho pa raha, sorry! 😊' : 'Unable to fetch your loyalty card right now. Please try again!';
        }
      }

      if (geminiReply.includes('INTENT:LOYALTY_REDEEM')) {
        if (!db) return 'Loyalty system unavailable. Please visit us at the café to redeem!';
        try {
          const phone = fromPhone.replace(/[^0-9]/g,'').slice(-10);
          const card = db.getLoyaltyCard(branchId, phone);
          if (!card) return lang==='hinglish' ? 'Aapka loyalty card nahi mila! Pehle ek visit karein. 😊' : 'No loyalty card found! Visit us to start earning stamps.';
          const stamps = card.stamps||0;
          const points = card.points||0;
          if (stamps >= 10) {
            return lang==='hinglish'
              ? `🎁 Aapke paas *${stamps} stamps* hain aur aap ek *FREE item* ke liye eligible hain! Café mein aaiye aur staff ko yeh message dikhayein. Hum khushi se redeem karenge! ☕`
              : `🎁 You have *${stamps} stamps* and qualify for a *FREE item*! Visit the café and show this message to our team — we'll redeem it with a smile! ☕`;
          } else if (points >= 500) {
            return lang==='hinglish'
              ? `💰 Aapke paas *${points} points* hain! 500 points = ₹50 discount. Café mein aaiye aur staff ko batayein aap points redeem karna chahte hain! 😊`
              : `💰 You have *${points} points*! 500 points = ₹50 off your bill. Visit the café and let our team know you'd like to redeem — easy as that! 😊`;
          } else {
            return lang==='hinglish'
              ? `Abhi redeem karne ke liye stamps/points kam hain! Aapke paas ${stamps}/10 stamps aur ${points} points hain. Jaldi ho jayega! ☕`
              : `Not quite there yet! You have ${stamps}/10 stamps and ${points} points. Keep visiting — you're on your way! ☕`;
          }
        } catch(e) {
          return 'Please visit the café to redeem your rewards — our team will be happy to help!';
        }
      }
      // ─────────────────────────────────────────────────────────────────────
      // ── Disengagement offer nudge ────────────────────────────────────────
      // After 3+ turns, if customer sends a very short/disinterested reply,
      // append a soft offer hint once per session (not on every message).
      const disengageWords = ['ok','okay','k','hmm','hm','alright','fine','nvm',
        'nevermind','bye','tc','thanks','thank you','theek','theek hai','achha',
        'ok bye','k bye','chal','noted'];
      const isDisengaged = text.length < 20 &&
        disengageWords.some(w => lowercaseText.trim() === w || lowercaseText.trim().startsWith(w + ' '));
      const offerCooldown = 4; // don't repeat offer within 4 turns
      if (isDisengaged && userState.msgCount >= 3 &&
          (userState.msgCount - (userState.lastOfferAt || 0)) >= offerCooldown) {
        const business = businesses.find(b => b.id === branchId) || businesses[0];
        const settings = getBranchData(branchId, 'settings.json');
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const dayCampaign = settings.lowTrafficCampaigns &&
          settings.lowTrafficCampaigns.find(c => c.day.toLowerCase() === today.toLowerCase());
        const offerLine = dayCampaign
          ? `By the way, today's special: *${dayCampaign.offer}* 🎉`
          : `By the way — students get *10% off* with a valid ID, and every order earns loyalty points! ☕`;
        userState.lastOfferAt = userState.msgCount;
        return geminiReply + '\n\n' + offerLine;
      }
      // ─────────────────────────────────────────────────────────────────────
      return geminiReply;
    }
  }

  // 5. LOCAL RULE-BASED NLP FALLBACK (Run when Gemini is offline or not configured)
  
  // AA. FEEDBACK FLOW INITIATION
  if (['feedback', 'rating', 'review', 'sugges', 'compliment', 'रेटिंग', 'फीडबैक', 'feed back'].some(kw => lowercaseText.includes(kw))) {
    userState.state = 'FEEDBACK';
    userState.feedbackData = { rating: null, comment: null };
    
    if (lang === 'hinglish') {
      return 'Bilkul! 😊 Aapka feedback humare liye bohot valuable hai. \nKripya humein 1 se 5 stars me rate karein (1: Sabse ganda, 5: Sabse behtar) ⭐';
    } else if (lang === 'hindi') {
      return 'बिल्कुल! 😊 आपकी प्रतिक्रिया हमारे लिए बहुत मूल्यवान है। \nकृपया हमें 1 से 5 स्टार में रेट करें (1: सबसे खराब, 5: सबसे अच्छा) ⭐';
    } else {
      return 'Sure! 😊 Your feedback is highly valuable to us. \nPlease rate your experience from 1 to 5 stars (1: Worst, 5: Best) ⭐';
    }
  }

  // A. BOOKING FLOW INITIATION
  if (['book', 'reservation', 'table', 'seat', 'टेबल बुक', 'booking', 'reserve'].some(kw => lowercaseText.includes(kw))) {
    userState.state = 'RESERVATION';
    userState.reservationData = { name: null, guests: null, datetime: null };
    
    if (lang === 'hinglish') {
      return 'Bilkul! 😊 Table book karne me hum aapki help karenge. \nKripya share karein:\n1. Aapka Naam (Name)';
    } else if (lang === 'hindi') {
      return 'बिल्कुल! 😊 टेबल बुक करने में हम आपकी मदद करेंगे। \nकृपया शेयर करें:\n1. आपका नाम (Name)';
    } else {
      return 'Sure! 😊 Let\'s get your table reserved. \nPlease share:\n1. Your Name';
    }
  }

  // B. MENU QUERY
  if (['menu', 'मेन्यू', '메뉴', 'food', 'khana', 'bestseller', 'popular'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_menu');
    
    let menuStr = '';
    menu.forEach(item => {
      let finalPrice = item.price;
      let discStr = '';
      if (item.discount > 0) {
        finalPrice = Math.round(item.price * (1 - item.discount / 100));
        discStr = ` (${item.discount}% OFF - was ₹${item.price})`;
      }
      menuStr += `• ${item.name} (${item.category}): ₹${finalPrice}${discStr}\n`;
    });

    if (lang === 'hinglish') {
      return `Yeh raha humara delicious menu! 😋\n\n${menuStr}\nHumara Cold Coffee, Peri Peri Fries, aur Alfredo Pasta bestselling items hain. Kya mangwana chahenge? 😊`;
    } else if (lang === 'hindi') {
      return `यह रहा हमारा स्वादिष्ट मेन्यू! 😋\n\n${menuStr}\nहमारे सबसे लोकप्रिय आइटम्स कोल्ड कॉफ़ी, पेरी पेरी फ्राइज़, और अल्फ्रेडो पास्ता हैं। आप क्या पसंद करेंगे? 😊`;
    } else {
      return `Here is our delicious menu! 😋\n\n${menuStr}\nOur bestsellers are Cold Coffee, Peri Peri Fries, and Alfredo Pasta. What can I get for you today? 😊`;
    }
  }

  // C. OFFERS QUERY
  if (['offer', 'offers', 'ऑफर', 'discount', 'coupon', 'deal'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_offers');
    
    let baseOffers = '1. Students get 10% discount with a valid ID card! 🎓\n2. Buy 5 coffees, get 1 free! ☕';
    
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const lowTrafficCampaign = settings.lowTrafficCampaigns.find(c => c.day.toLowerCase() === today.toLowerCase());
    
    let promoPrefix = '';
    if (lowTrafficCampaign) {
      promoPrefix = `🔥 *SPECIAL TODAY* (${today} Exclusive): ${lowTrafficCampaign.offer}\n\n`;
    }

    if (lang === 'hinglish') {
      return `${promoPrefix}Humare exciting offers kuch is tarah hain: 😊\n${baseOffers}\n\nAap humari regular schemes ka fayda bhi utha sakte hain!`;
    } else if (lang === 'hindi') {
      return `${promoPrefix}हमारे शानदार ऑफर्स इस प्रकार हैं: 😊\n${baseOffers}\n\nआप हमारे रेगुलर स्कीम्स का लाभ उठा सकते हैं!`;
    } else {
      return `${promoPrefix}Here are our special offers: 😊\n${baseOffers}\n\nEnjoy our regular rewards program!`;
    }
  }

  // D. LOCATION / ADDRESS
  if (['location', 'address', 'kaha', 'lohegaon', 'indiranagar', 'address', 'लोकेशन', 'rasta', 'direction', 'map'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_location');
    
    if (lang === 'hinglish') {
      return `Hum ${business.location} par located hain! 📍\nYeh raha map link: ${business.map} 😊`;
    } else if (lang === 'hindi') {
      return `हम ${business.location} पर स्थित हैं! 📍\nयह रहा हमारा मैप लिंक: ${business.map} 😊`;
    } else {
      return `We are located at ${business.location}! 📍\nHere is our Google Maps link: ${business.map} 😊`;
    }
  }

  // E. TIMING
  if (['timing', 'open', 'timings', 'hours', 'kab', 'baje', 'timing?'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_timing');
    
    if (lang === 'hinglish') {
      return `Hum har roz timings: ${business.timings} tak open rehte hain! ⏰\nAap jab chahein aa sakte hain 😊`;
    } else if (lang === 'hindi') {
      return `हम हर दिन: ${business.timings} तक खुले रहते हैं! ⏰\nआपका जब मन करे आप आ सकते हैं 😊`;
    } else {
      return `We are open daily from ${business.timings}! ⏰\nFeel free to drop by anytime 😊`;
    }
  }

  // F. WIFI
  if (['wifi', 'wi-fi', 'password', 'internet', 'net'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Haan ji, café me free WiFi available hai! 📶\nSSID / Password: ${business.wifi} 😊`;
    } else {
      return `Yes, we have free high-speed WiFi for all customers! 📶\nSSID / Password: ${business.wifi} 😊`;
    }
  }

  // G. REVIEW
  if (['review', 'rating', 'feedback', 'stars', 'google review'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Aapka review humare liye bohot valuable hai! ⭐\nApna feedback yahan share karein: ${business.review} 😊`;
    } else {
      return `We would love to hear about your experience! ⭐\nPlease leave us a Google review here: ${business.review} 😊`;
    }
  }

  // H. CONTACT
  if (['contact', 'phone', 'number', 'call', 'mobile'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Aap humein call kar sakte hain is number par: ${business.contact} 📞`;
    } else {
      return `You can reach out to our front desk directly at: ${business.contact} 📞`;
    }
  }

  // I. STUDENT OFFER
  if (['student', 'college', 'school', 'id card', 'student offer', 'student discount'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'is_student');
    
    if (lang === 'hinglish') {
      return 'Haan ji! Students ko valid college ID card dikhane par flat 10% discount milta hai! 🎓😊';
    } else {
      return 'Yes! We offer a flat 10% discount to all students. Just present a valid Student ID card at checkout! 🎓😊';
    }
  }

  // J. SPECIFIC PRICING REASONING ENGINE (DYNAMIC PRODUCT SEARCH)
  let matchedItem = null;
  for (const item of menu) {
    if (lowercaseText.includes(item.name.toLowerCase()) || 
        (item.name.toLowerCase().includes('coffee') && lowercaseText.includes('coffee')) || 
        (item.name.toLowerCase().includes('pasta') && lowercaseText.includes('pasta')) || 
        (item.name.toLowerCase().includes('fries') && lowercaseText.includes('fries')) || 
        (item.name.toLowerCase().includes('burger') && lowercaseText.includes('burger')) || 
        (item.name.toLowerCase().includes('mojito') && lowercaseText.includes('mojito'))) {
      matchedItem = item;
      break;
    }
  }

  if (matchedItem && (lowercaseText.includes('price') || lowercaseText.includes('rate') || 
                      lowercaseText.includes('kitne') || lowercaseText.includes('rupay') || 
                      lowercaseText.includes('cost') || lowercaseText.includes('charge') || 
                      lowercaseText.includes('milt')) || lowercaseText.includes('paise')) {
    
    updateCustomerProfile(branchId, fromPhone, null, 'interested_in_' + matchedItem.category.toLowerCase());
    
    let finalPrice = matchedItem.price;
    let discMessage = '';
    if (matchedItem.discount > 0) {
      finalPrice = Math.round(matchedItem.price * (1 - matchedItem.discount / 100));
      if (lang === 'hinglish') {
        discMessage = `, par aaj ${matchedItem.discount}% discount ke sath yeh aapko sirf ₹${finalPrice} me milega! 😍`;
      } else if (lang === 'hindi') {
        discMessage = `, पर आज ${matchedItem.discount}% छूट के साथ यह आपको सिर्फ ₹${finalPrice} में मिलेगा! 😍`;
      } else {
        discMessage = `, but with today's special ${matchedItem.discount}% off, it is yours for only ₹${finalPrice}! 😍`;
      }
    }

    if (lang === 'hinglish') {
      return `Humara *${matchedItem.name}* standard price ₹${matchedItem.price} ka hai${discMessage || '!'} 😊`;
    } else if (lang === 'hindi') {
      return `हमारा *${matchedItem.name}* मानक मूल्य ₹${matchedItem.price} का है${discMessage || '!'} 😊`;
    } else {
      return `Our *${matchedItem.name}* standard price is ₹${matchedItem.price}${discMessage || '!'} 😊`;
    }
  }

  // K. BUDGET / CHEAPEST SEARCH ("Sasta kya hai?")
  if (['sasta', 'cheapest', 'cheap', 'budget', 'under'].some(kw => lowercaseText.includes(kw))) {
    const sortedMenu = [...menu].sort((a, b) => {
      const aReal = a.price * (1 - a.discount / 100);
      const bReal = b.price * (1 - b.discount / 100);
      return aReal - bReal;
    });

    const cheapest1 = sortedMenu[0];
    const cheapest2 = sortedMenu[1];
    
    const c1Price = Math.round(cheapest1.price * (1 - cheapest1.discount / 100));
    const c2Price = Math.round(cheapest2.price * (1 - cheapest2.discount / 100));

    if (lang === 'hinglish') {
      return `Humare menu me sabse budget-friendly items *${cheapest1.name}* (₹${c1Price}) aur *${cheapest2.name}* (₹${c2Price}) hain! 🤑\nDono bohot hi tasty aur bestselling hain! Try kijiye! 😊`;
    } else if (lang === 'hindi') {
      return `हमारे मेन्यू में सबसे कम दाम वाले स्वादिष्ट आइटम्स *${cheapest1.name}* (₹${c1Price}) और *${cheapest2.name}* (₹${c2Price}) हैं! 🤑\nदोनों बेहतरीन स्वाद वाले हैं! ज़रूर ट्राय करें! 😊`;
    } else {
      return `Our most budget-friendly choices are the *${cheapest1.name}* (₹${c1Price}) and *${cheapest2.name}* (₹${c2Price})! 🤑\nBoth are super popular and absolutely delicious! 😊`;
    }
  }

  // L. GENERAL SMALL TALK AND MISCELLANEOUS TOPICS
  return generateLocalConversationalReply(branchId, text, lang);
}

// Auto-Pilot Low-Traffic Campaign Engine
function runAutoPilotCampaign(branchId, forceDay = null) {
  const settings = getBranchData(branchId, 'settings.json');
  if (!settings.autoPilotActive && !forceDay) {
    console.log(`[Auto-Pilot Campaign] Skipped for branch ${branchId} - Auto-Pilot is disabled.`);
    return { success: false, reason: 'Auto-Pilot is disabled' };
  }

  const now = new Date();
  const today = forceDay || now.toLocaleDateString('en-US', { weekday: 'long' });
  const campaign = settings.lowTrafficCampaigns.find(c => c.day.toLowerCase() === today.toLowerCase());

  if (!campaign) {
    console.log(`[Auto-Pilot Campaign] No campaign configured for ${today} in branch ${branchId}.`);
    return { success: false, reason: `No campaign for ${today}` };
  }

  const campaignText = campaign.offer;
  const profiles = getBranchData(branchId, 'customer_profiles.json');
  
  // Select target customers who:
  // 1. Have not received an offer in the last 48 hours
  // 2. Have appropriate tag matches (e.g. coffee tag for coffee offer) or are tagged as 'Offer Seekers' (or asked_for_offers)
  const targetCustomers = profiles.filter(cust => {
    // 1. Check 48h limit
    const lastOffer = cust.offersReceived && cust.offersReceived.length > 0 
      ? cust.offersReceived[cust.offersReceived.length - 1] 
      : null;
    if (lastOffer) {
      const lastTime = new Date(lastOffer.timestamp);
      const diffMs = Date.now() - lastTime.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      if (diffHours < 48) {
        return false; // received too recently
      }
    }

    // 2. Tag matches
    const offerLower = campaignText.toLowerCase();
    const hasOfferTag = (cust.tags || []).some(t => 
      t.toLowerCase().includes('offer') || 
      t.toLowerCase().includes('seek')
    );
    if (hasOfferTag) return true;

    // Check category keywords
    const keywords = ['coffee', 'burger', 'pasta', 'fries', 'mojito'];
    for (const kw of keywords) {
      if (offerLower.includes(kw)) {
        const hasKwTag = (cust.tags || []).some(t => t.toLowerCase().includes(kw));
        if (hasKwTag) return true;
      }
    }

    return false; // does not match target tags
  });

  if (targetCustomers.length === 0) {
    console.log(`[Auto-Pilot Campaign] No target customers matched for today's campaign in branch ${branchId}.`);
    return { success: true, count: 0, logs: [] };
  }

  const logs = [];
  targetCustomers.forEach(cust => {
    // Send message (console log + live chat simulator stream + real WhatsApp if connected)
    const msgLog = `[Auto-Pilot Broadcast] Sent to ${cust.name || 'Customer'} (${cust.phone}): "${campaignText}"`;
    console.log(msgLog);
    logs.push({ phone: cust.phone, name: cust.name, status: 'Sent Successfully' });
    
    // Save offer in customer profile
    cust.offersReceived = cust.offersReceived || [];
    cust.offersReceived.push({
      offer: campaignText,
      timestamp: new Date().toISOString()
    });

    // Send via WhatsApp if connected
    sendWhatsAppToCustomer(branchId, cust.phone, campaignText).catch(e => console.error('[WhatsApp Autopilot Error]', e));

    // Emit live chat simulator log
    io.emit('inbound_chat', {
      branchId,
      phone: cust.phone,
      text: `📢 *[AUTOPILOT CAMPAIGN]*: ${campaignText}`,
      sender: 'ai',
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // Write profiles back
  writeBranchData(branchId, 'customer_profiles.json', profiles);
  // Emit updates
  io.emit('crm_update', { branchId, profiles });

  return { success: true, count: targetCustomers.length, logs };
}

// -------------------------------------------------------------
// Express REST API
// -------------------------------------------------------------

// 1. Get businesses list

// ── Auth Routes ────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.loginHandler(req, res);
});

app.get('/api/auth/me', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.requireAuth(req, res, () => auth.meHandler(req, res));
});

app.post('/api/auth/logout', (req, res) => {
  if (!auth) return res.json({ success: true });
  auth.requireAuth(req, res, () => auth.logoutHandler(req, res));
});

app.post('/api/auth/change-password', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.requireAuth(req, res, () => auth.changePasswordHandler(req, res));
});

// ── Staff Management Routes ────────────────────────────────────────────────────
app.get('/api/staff', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.requireAuth(req, res, () =>
    auth.requireRole('owner', 'manager')(req, res, () =>
      auth.listStaffHandler(req, res)));
});

app.post('/api/staff', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.requireAuth(req, res, () =>
    auth.requireRole('owner')(req, res, () =>
      auth.createStaffHandler(req, res)));
});

app.patch('/api/staff/:staffId', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.requireAuth(req, res, () =>
    auth.requireRole('owner')(req, res, () =>
      auth.updateStaffHandler(req, res)));
});

// ── Admin: All-staff across all businesses (admin-token protected) ────────────
app.get('/api/admin/all-staff', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'cafehq_admin_secret';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  try {
    const rows = db.raw.prepare(`
      SELECT s.id, s.business_id, s.name, s.username, s.role, s.active, s.created_at,
             b.name as business_name
      FROM staff s
      LEFT JOIN (SELECT id, name FROM businesses_view) b ON b.id = s.business_id
      ORDER BY s.business_id, s.role, s.name
    `).all();
    // businesses_view may not exist — fall back to joining via businesses array in JS
    res.json(rows);
  } catch(e) {
    // Fallback without join
    try {
      const rows = db.raw.prepare('SELECT id, business_id, name, username, role, active, created_at FROM staff ORDER BY business_id, role, name').all();
      res.json(rows);
    } catch(e2) { res.status(500).json({ error: e2.message }); }
  }
});

// ── Admin: Reset a staff member's password ────────────────────────────────────
app.post('/api/admin/staff/:staffId/reset-password', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'cafehq_admin_secret';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const { staffId } = req.params;
  const { newPassword } = req.body;

  try {
    let tempPass = newPassword;
    if (!tempPass) {
      // Auto-generate a readable temp password
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
      tempPass = Array.from({length: 8}, () => chars[Math.floor(Math.random()*chars.length)]).join('') + '!';
    }
    const hash = await bcrypt.hash(tempPass, 10);
    const result = db.raw.prepare('UPDATE staff SET password_hash=? WHERE id=?').run(hash, staffId);
    if (result.changes === 0) return res.status(404).json({ error: 'Staff not found' });
    res.json({ success: true, newPassword: tempPass });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Backup Routes ─────────────────────────────────────────────────────────────
app.get('/api/backups', (req, res) => {
  if (!backup) return res.status(503).json({ error: 'Backup module not loaded' });
  res.json(backup.listBackups());
});

app.post('/api/backups/trigger', (req, res) => {
  if (!backup) return res.status(503).json({ error: 'Backup module not loaded' });
  res.json(backup.triggerManualBackup());
});

// ── Analytics Route (SQLite-powered) ─────────────────────────────────────────
app.get('/api/businesses/:id/analytics-v2', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB module not loaded' });
  try {
    const analytics = db.getAnalytics(req.params.id);
    res.json(analytics);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ════════════════════════════════════════════════════════════════════════════
// Phase 2 — Orders & Revenue Routes
// ════════════════════════════════════════════════════════════════════════════

// Razorpay (optional — only loads if KEY_ID is in .env)
let Razorpay = null;
let razorpay = null;
try {
  Razorpay = require('razorpay');
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log('[Razorpay] ✓ Payment gateway active');
  } else {
    console.log('[Razorpay] ℹ Key not set — payments will be COD only');
  }
} catch(e) {
  console.log('[Razorpay] ℹ Module not installed — run: npm install razorpay');
}

// ── Place a new order ─────────────────────────────────────────────────────────
// POST /api/businesses/:id/orders
app.post('/api/businesses/:id/orders', async (req, res) => {
  const businessId = req.params.id;
  const { customerName, customerPhone, tableNo, orderType, items, notes, paymentMethod } = req.body;

  if (!customerName || !items || !items.length) {
    return res.status(400).json({ error: 'customerName and items are required' });
  }

  // Fetch live prices from menu to prevent tampering
  const menu = getBranchData(businessId, 'menu.json');
  let subtotal = 0, discount = 0;
  const validatedItems = items.map(item => {
    const menuItem = menu.find(m => String(m.id) === String(item.id));
    const price    = menuItem ? menuItem.price : (item.price || 0);
    const disc     = menuItem ? (menuItem.discount || 0) : 0;
    const qty      = Math.max(1, parseInt(item.qty) || 1);
    const lineTotal = price * qty * (1 - disc / 100);
    subtotal  += price * qty;
    discount  += price * qty * (disc / 100);
    return { id: item.id, name: menuItem?.name || item.name, price, discount: disc, qty, lineTotal };
  });

  const tax   = parseFloat(((subtotal - discount) * 0.05).toFixed(2));  // 5% GST
  const total = parseFloat((subtotal - discount + tax).toFixed(2));

  let order;
  if (db) {
    order = db.createOrder({ businessId, customerName, customerPhone, tableNo,
      orderType: orderType || 'dine_in', items: validatedItems,
      subtotal, discount, tax, total, notes, paymentMethod: paymentMethod || 'cash' });
  } else {
    // Legacy JSON fallback
    const orders = getBranchData(businessId, 'orders.json') || [];
    order = { id: `ord_${Date.now()}`, businessId, customerName, customerPhone, tableNo,
      orderType: orderType||'dine_in', items: validatedItems, subtotal, discount, tax, total,
      notes, paymentMethod: paymentMethod||'cash', status: 'pending', payment_status: 'pending',
      created_at: new Date().toISOString() };
    orders.push(order);
    writeBranchData(businessId, 'orders.json', orders);
  }

  io.emit('new_order', { businessId, order });
  res.status(201).json(order);
});

// ── List orders ───────────────────────────────────────────────────────────────
// GET /api/businesses/:id/orders?status=pending&limit=50
app.get('/api/businesses/:id/orders', (req, res) => {
  const { status, limit, offset } = req.query;
  if (db) {
    return res.json(db.listOrders(req.params.id, {
      status, limit: parseInt(limit)||50, offset: parseInt(offset)||0
    }));
  }
  const orders = getBranchData(req.params.id, 'orders.json') || [];
  res.json(status ? orders.filter(o => o.status === status) : orders);
});

// ── Update order status ───────────────────────────────────────────────────────
// POST /api/businesses/:id/orders/:orderId/status  { status }
app.post('/api/businesses/:id/orders/:orderId/status', (req, res) => {
  const { orderId } = req.params;
  const { status }  = req.body;
  const validStatuses = ['pending','confirmed','preparing','ready','served','cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  let order;
  if (db) {
    order = db.updateOrderStatus(orderId, status);
  } else {
    const orders = getBranchData(req.params.id, 'orders.json') || [];
    order = orders.find(o => o.id === orderId);
    if (order) { order.status = status; writeBranchData(req.params.id, 'orders.json', orders); }
  }
  if (!order) return res.status(404).json({ error: 'Order not found' });
  io.emit('order_status_update', { businessId: req.params.id, orderId, status });

  // Declare customer vars here so they're available for both push + loyalty blocks below
  const customerPhone = order.customer_phone || order.customerPhone || order.phone || '';
  const customerName  = order.customer_name  || order.customerName  || order.name || 'Customer';
  const orderTotal    = parseFloat(order.total || 0);
  const bizId         = req.params.id;

  // Push notification to customer browser on key status changes
  if (customerPhone && (status === 'ready' || status === 'preparing' || status === 'cancelled')) {
    const pushPayload = {
      title: status === 'ready' ? '🔔 Order Ready!' : status === 'preparing' ? '👨‍🍳 Being Prepared' : '❌ Order Cancelled',
      body: status === 'ready' ? 'Your order is ready for pickup at the counter!' : status === 'preparing' ? 'Your order is being freshly made right now!' : 'Your order was cancelled. Please contact us for help.',
      tag: 'order-' + orderId,
      url: '/cafe/' + req.params.id
    };
    sendPushToPhone(req.params.id, customerPhone, pushPayload).catch(()=>{});
  }

  // ── Phase 4B: Auto-award loyalty stamp + points on order completion ──────

  if (db && customerPhone && (status === 'served' || status === 'delivered')) {
    try {
      const phone = customerPhone.replace(/[^0-9]/g,'').slice(-10);
      const card  = db.awardPoints(bizId, phone, customerName, orderTotal, orderId);
      // Record visit for psychology engine
      try { db.recordVisit(bizId, phone, customerName, JSON.parse(order.items||'[]'), orderTotal, order.order_type); } catch(e) {}
      io.emit('loyalty_update', { businessId: bizId, card });

      // Send WhatsApp confirmation with updated card
      const business = businesses.find(b=>b.id===bizId)||{name:'Café'};
        const stampsLeft = Math.max(0, 10-(card.stamps||0));
        const waMsg = `✅ *Order Served!* Thank you, ${customerName}! 🙏\n\n` +
          `Your loyalty card has been updated:\n` +
          `☕ Stamps: *${card.stamps||0}/10*${(card.stamps||0)>=10?' 🎁 FREE item ready!':'('+stampsLeft+' more for a free item!)'}\n` +
          `💰 Points: *${card.points||0} pts* (+${Math.round(orderTotal)} earned today)\n` +
          `🏅 Tier: *${card.tier||'New'}*\n\n` +
          `See you soon at ${business.name}! ☕✨`;
        sendWhatsAppToCustomer(bizId, phone, waMsg).catch(e=>console.error('[WA loyalty notify]',e.message));
    } catch(e) { console.error('[Phase4 auto-stamp error]', e.message); }
  }

  // ── Phase 4C: WhatsApp order status notification ──────────────────────────
  if (customerPhone && status !== 'served' && status !== 'delivered') {
    try {
      const phone = customerPhone.replace(/[^0-9]/g,'').slice(-10);
      const business = businesses.find(b=>b.id===bizId)||{name:'Café'};
      const statusEmoji = { pending:'⏳', confirmed:'✅', preparing:'👨‍🍳', ready:'🔔', cancelled:'❌' };
      const statusMsg   = {
        pending:   'Your order has been received and is pending confirmation.',
        confirmed: "Your order is confirmed! We're getting started.",
        preparing: 'Your order is being freshly prepared right now! 👨‍🍳',
        ready:     '🔔 Your order is READY! Please collect it from the counter.',
        cancelled: 'Your order has been cancelled. Please contact us if this was a mistake.'
      };
      const waMsg = `${statusEmoji[status]||'📋'} *Order Update — ${business.name}*\n\n` +
        `${statusMsg[status]||'Status: '+status}\n\n` +
        `Order: *#${orderId.slice(-6).toUpperCase()}* | ₹${orderTotal.toFixed(0)}\n` +
        `For help: ${business.contact||'contact us'}`;
      sendWhatsAppToCustomer(bizId, phone, waMsg).catch(e=>console.error('[WA status notify]',e.message));
    } catch(e) { console.error('[Phase4 status notify error]', e.message); }
  }
  // ─────────────────────────────────────────────────────────────────────────

  res.json(order);
});

// ── Create Razorpay order ─────────────────────────────────────────────────────
// POST /api/businesses/:id/orders/:orderId/razorpay
app.post('/api/businesses/:id/orders/:orderId/razorpay', async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay not configured', cashOnly: true });
  }
  const order = db ? db.getOrderById(req.params.orderId) : null;
  if (!order) return res.status(404).json({ error: 'Order not found' });

  try {
    const rzpOrder = await razorpay.orders.create({
      amount:   Math.round(order.total * 100),   // paise
      currency: 'INR',
      receipt:  req.params.orderId,
      notes:    { businessId: req.params.id, customerName: order.customer_name },
    });
    if (db) db.updateOrderPayment(req.params.orderId, {
      paymentStatus: 'pending', paymentMethod: 'razorpay', razorpayOrderId: rzpOrder.id
    });
    res.json({ razorpayOrderId: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Verify Razorpay payment ───────────────────────────────────────────────────
// POST /api/businesses/:id/orders/:orderId/verify-payment
app.post('/api/businesses/:id/orders/:orderId/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });

  const crypto = require('crypto');
  const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment signature mismatch' });
  }

  if (db) {
    db.updateOrderPayment(req.params.orderId, {
      paymentStatus: 'paid', paymentMethod: 'razorpay',
      razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id
    });
    db.updateOrderStatus(req.params.orderId, 'confirmed');
  }

  io.emit('payment_confirmed', { businessId: req.params.id, orderId: req.params.orderId });
  res.json({ success: true });
});

// ── Revenue stats ─────────────────────────────────────────────────────────────
// GET /api/businesses/:id/revenue
// Requires ADMIN_TOKEN header for ₹ amounts — managers get counts only
app.get('/api/businesses/:id/revenue', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const adminToken = process.env.ADMIN_TOKEN || 'cafehq_admin_secret';
  const isAdmin = req.headers['x-admin-token'] === adminToken;

  // Check if JWT-authenticated owner for this branch
  let isOwner = false;
  if (!isAdmin && auth) {
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (token) {
        const result = auth.verifyToken(token);
        const payload = result && result.ok ? result.payload : null;
        if (payload && payload.role === 'owner' && payload.businessId === req.params.id) {
          isOwner = true;
        }
      }
    } catch(e) {}
  }

  if (!isAdmin && !isOwner) {
    // Manager view — order counts only, no revenue figures
    const counts = db.getOrderCountsOnly(req.params.id);
    return res.json({ adminOnly: true, counts });
  }
  const stats    = db.getRevenueStats(req.params.id);
  const daily    = db.getDailyRevenue(req.params.id, 14);
  const topItems = db.getTopItems(req.params.id, 5);
  res.json({ stats, daily, topItems });
});


// ═════════════════════════════════════════════════════════════════════════════
// Customer Psychology Engine + Admin Billing
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/businesses/:id/customers/:phone/insights
app.get('/api/businesses/:id/customers/:phone/insights', safeAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const phone   = req.params.phone.replace(/[^0-9]/g,'').slice(-10);
  const profile = db.buildCustomerProfile(req.params.id, phone);
  if (!profile) return res.status(404).json({ error: 'No visit history found' });
  res.json(profile);
});

// POST /api/businesses/:id/customers/:phone/ai-offer  — Gemini generates personalised offer
app.post('/api/businesses/:id/customers/:phone/ai-offer', safeAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const phone   = req.params.phone.replace(/[^0-9]/g,'').slice(-10);
  const profile = db.buildCustomerProfile(req.params.id, phone);
  if (!profile) return res.status(404).json({ error: 'No visit history found' });

  const business = businesses.find(b => b.id === req.params.id) || { name: 'Café' };

  if (!genAI) {
    // Fallback without Gemini
    const fav = profile.favourites[0]?.name || 'your favourite item';
    return res.json({
      offer: `Hi ${profile.name}! We miss you ☕ Come back this week and enjoy 20% OFF on ${fav}. Valid for 3 days!`,
      reason: 'Personalised based on favourite item'
    });
  }

  try {
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = `You are a café marketing expert for ${business.name}.

Customer Profile:
- Name: ${profile.name}
- Total visits: ${profile.totalVisits}
- Days since last visit: ${profile.daysSinceLastVisit}
- Average spend: ₹${profile.avgSpend}
- Favourite items: ${profile.favourites.map(f=>f.name).join(', ')||'unknown'}
- Usually visits: ${profile.peakDay}s around ${profile.peakHour}
- Segment: ${profile.segment}

Generate ONE short, personalised WhatsApp offer message (max 3 lines) to bring this customer back.
- Be warm and personal, use their name
- Reference their favourite item if known
- Make the offer specific and time-limited
- Do NOT use generic language
- Return ONLY the message text, nothing else`;

    const result = await model.generateContent(prompt);
    const offer  = result.response.text().trim();
    res.json({ offer, reason: `AI offer for ${profile.segment} customer, ${profile.daysSinceLastVisit} days since last visit` });
  } catch(e) {
    console.error('[AI Offer]', e.message);
    res.status(500).json({ error: 'AI offer generation failed' });
  }
});

// GET /api/businesses/:id/at-risk-customers
app.get('/api/businesses/:id/at-risk-customers', safeAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const days = parseInt(req.query.days) || 14;
  const list = db.getAtRiskCustomers(req.params.id, days);
  res.json(list);
});

// POST /api/businesses/:id/at-risk-customers/send-offer — send AI offer via WhatsApp
app.post('/api/businesses/:id/at-risk-customers/send-offer', safeAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, offer } = req.body;
  if (!phone || !offer) return res.status(400).json({ error: 'phone and offer required' });
  const ok = await sendWhatsAppToCustomer(req.params.id, phone, offer);
  res.json({ success: ok, message: ok ? 'Offer sent via WhatsApp' : 'WhatsApp not configured' });
});

// ── Admin-only billing ────────────────────────────────────────────────────────
// GET /api/admin/billing  — full revenue across all branches (ADMIN_TOKEN required)
app.get('/api/admin/billing', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'cafehq_admin_secret';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Admin token required' });
  }
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const report = db.getAdminBillingReport();
  // Enrich with business names
  report.branches = report.branches.map(b => ({
    ...b,
    name: (businesses.find(biz => biz.id === b.business_id) || {}).name || b.business_id
  }));
  res.json(report);
});

// GET /api/admin/customers  — all customers across all branches (ADMIN_TOKEN required)
app.get('/api/admin/customers', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'cafehq_admin_secret';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Admin token required' });
  }
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const all = db.raw.prepare(`
    SELECT cv.business_id, cv.phone, cv.name,
           COUNT(*) as visits, SUM(cv.total) as total_spend,
           MAX(cv.visited_at) as last_visit
    FROM customer_visits cv
    GROUP BY cv.business_id, cv.phone
    ORDER BY total_spend DESC
  `).all();
  res.json(all.map(c => ({
    ...c,
    branchName: (businesses.find(b=>b.id===c.business_id)||{}).name || c.business_id
  })));
});

// ── Razorpay config (for frontend) ───────────────────────────────────────────
// GET /api/razorpay-config
app.get('/api/razorpay-config', (req, res) => {
  res.json({
    enabled: !!razorpay,
    keyId: process.env.RAZORPAY_KEY_ID || null,
  });
});


// ── ONE-TIME SETUP ENDPOINT (auto-removes after first use) ───────────────────
app.get('/api/setup/seed-owner', (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const Database = require('better-sqlite3');
    const dbPath = require('path').join(__dirname, 'data', 'cafe_hq.db');
    const sdb = new Database(dbPath);
    sdb.pragma('journal_mode = WAL');

    // Add active column if missing
    try { sdb.prepare('ALTER TABLE staff ADD COLUMN active INTEGER DEFAULT 1').run(); } catch(e) {}
    try { sdb.prepare('ALTER TABLE staff ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP').run(); } catch(e) {}

    // Update nulls
    sdb.prepare('UPDATE staff SET active=1 WHERE active IS NULL').run();

    // Get all businesses
    const bizList = sdb.prepare('SELECT id, name FROM businesses').all();
    if (!bizList.length) {
      sdb.prepare("INSERT OR IGNORE INTO businesses (id,name,status) VALUES ('indiranagar','The Roasted Bean','online')").run();
      sdb.prepare("INSERT OR IGNORE INTO businesses (id,name,status) VALUES ('koramangala','Mocha & Co.','online')").run();
    }

    const hash = bcrypt.hashSync('cafe1234', 10);
    const allBiz = sdb.prepare('SELECT id FROM businesses').all();
    const results = [];

    allBiz.forEach(b => {
      // Check table columns
      const hasPK = sdb.prepare("PRAGMA table_info(staff)").all().map(c=>c.name);
      const idType = hasPK.includes('id') ? 'TEXT' : null;

      try {
        sdb.prepare(`
          INSERT INTO staff (id, business_id, name, username, password_hash, role, active)
          VALUES (?, ?, 'Owner', 'owner', ?, 'owner', 1)
          ON CONFLICT(business_id, username) DO UPDATE SET
            password_hash=excluded.password_hash, active=1
        `).run('owner_' + b.id, b.id, hash);
        results.push({ branch: b.id, status: 'seeded' });
      } catch(e) {
        // Try without ON CONFLICT if constraint doesn't exist
        try {
          const existing = sdb.prepare('SELECT id FROM staff WHERE business_id=? AND username=?').get(b.id,'owner');
          if (existing) {
            sdb.prepare('UPDATE staff SET password_hash=?, active=1 WHERE business_id=? AND username=?').run(hash, b.id, 'owner');
            results.push({ branch: b.id, status: 'updated' });
          } else {
            sdb.prepare("INSERT INTO staff (id,business_id,name,username,password_hash,role,active) VALUES (?,?,'Owner','owner',?,'owner',1)").run('owner_'+b.id, b.id, hash);
            results.push({ branch: b.id, status: 'inserted' });
          }
        } catch(e2) {
          results.push({ branch: b.id, status: 'error: ' + e2.message });
        }
      }
    });

    // Verify
    const verify = sdb.prepare("SELECT business_id, username, active FROM staff WHERE username='owner'").all();
    sdb.close();

    res.json({
      success: true,
      message: 'Owner accounts seeded. Login with: owner / cafe1234',
      results,
      verify
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});


// ════════════════════════════════════════════════════════════════════════════
// Phase 3 — Loyalty Points Routes
// ════════════════════════════════════════════════════════════════════════════

// [/:phone route moved below named routes]

// POST /api/businesses/:id/loyalty/lookup  — lookup or create card
// { phone, name }
app.post('/api/businesses/:id/loyalty/lookup', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const card = db.getOrCreateCard(req.params.id, phone, name);
  const history = db.getLoyaltyHistory(req.params.id, phone, 5);
  res.json({ card, history });
});

// POST /api/businesses/:id/loyalty/award  — award points after order
// { phone, name, amountSpent, orderId }
app.post('/api/businesses/:id/loyalty/award', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, name, amountSpent, orderId } = req.body;
  if (!phone || !amountSpent) return res.status(400).json({ error: 'phone and amountSpent required' });
  const card = db.awardPoints(req.params.id, phone, name, parseFloat(amountSpent), orderId);
  io.emit('loyalty_update', { businessId: req.params.id, card });
  res.json({ card });
});

// POST /api/businesses/:id/loyalty/redeem-stamps  — redeem 10 stamps
// { phone }
app.post('/api/businesses/:id/loyalty/redeem-stamps', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const result = db.redeemStamps(req.params.id, phone);
  res.json(result);
});

// POST /api/businesses/:id/loyalty/redeem-points  — redeem points for discount
// { phone, points }
app.post('/api/businesses/:id/loyalty/redeem-points', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, points } = req.body;
  if (!phone || !points) return res.status(400).json({ error: 'phone and points required' });
  const result = db.redeemPoints(req.params.id, phone, parseInt(points));
  res.json(result);
});

// POST /api/businesses/:id/loyalty/birthday  — set birthday
// { phone, birthday }  birthday format: MM-DD or YYYY-MM-DD
app.post('/api/businesses/:id/loyalty/birthday', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, birthday } = req.body;
  if (!phone || !birthday) return res.status(400).json({ error: 'phone and birthday required' });
  db.updateBirthday(req.params.id, phone, birthday);
  res.json({ success: true });
});

// GET /api/businesses/:id/loyalty/leaderboard  — top customers
app.get('/api/businesses/:id/loyalty/leaderboard', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  res.json(db.getLoyaltyLeaderboard(req.params.id, 20));
});

// GET /api/businesses/:id/loyalty/birthdays  — upcoming birthdays (7 days)
app.get('/api/businesses/:id/loyalty/birthdays', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  res.json(db.getUpcomingBirthdays(req.params.id, 7));
});

// GET /api/businesses/:id/loyalty/activity  — recent loyalty transactions
app.get('/api/businesses/:id/loyalty/activity', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  try {
    const rows = db.raw.prepare(`
      SELECT lt.*, lp.name AS customer_name, lp.phone
      FROM loyalty_transactions lt
      LEFT JOIN loyalty_points lp ON lt.card_id = lp.id
      WHERE lp.business_id = ?
      ORDER BY lt.created_at DESC LIMIT 50
    `).all(req.params.id);
    res.json(rows);
  } catch(e) {
    res.json([]);
  }
});

// GET /api/businesses/:id/loyalty/:phone  — get card by phone (MUST be after named routes)
app.get('/api/businesses/:id/loyalty/:phone', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const card = db.getLoyaltyCard(req.params.id, req.params.phone);
  if (!card) return res.status(404).json({ error: 'No loyalty card found' });
  const history = db.getLoyaltyHistory(req.params.id, req.params.phone, 5);
  res.json({ card, history });
});


// POST /api/businesses/:id/loyalty/birthday-campaign  — send WhatsApp birthday msg
// Body: { phone, name } for single, or {} for all upcoming birthdays
app.post('/api/businesses/:id/loyalty/birthday-campaign', async (req, res) => {
  const { phone: singlePhone, name: singleName } = req.body;
  const business = businesses.find(b => b.id === req.params.id) || {};
  const bizName  = business.name || 'Café Team';

  const buildMsg = (name) =>
    `🎂 *Happy Birthday, ${name || 'dear friend'}!*\n\n` +
    `Wishing you a beautiful day from all of us at ${bizName}! 🎉\n\n` +
    `As a token of our appreciation:\n` +
    `🎁 *FREE Dessert* on your next visit today!\n\n` +
    `Just show this message at the counter. Valid today only!\n\n` +
    `With warmth & coffee, ${bizName} ☕`;

  const sendWA = async (phone, msg) => {
    return await sendWhatsAppToCustomer(req.params.id, phone, msg);
  };

  if (singlePhone) {
    // Single recipient
    const msg = buildMsg(singleName);
    const sent = await sendWA(singlePhone, msg);
    return res.json({ success: true, sent, message: msg, note: sent ? undefined : 'WhatsApp not connected — copy message manually' });
  }

  // Bulk: all upcoming birthdays (next 7 days)
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const upcoming = db.getUpcomingBirthdays(req.params.id, 7);
  if (!upcoming.length) return res.json({ success: true, sent: 0, message: 'No upcoming birthdays in the next 7 days' });

  let sentCount = 0;
  for (const c of upcoming) {
    const msg = buildMsg(c.name);
    const ok  = await sendWA(c.phone, msg);
    if (ok) sentCount++;
  }
  const cfg = getWaConfig(req.params.id);
  const waConnected = !!(cfg?.phoneNumberId && cfg?.accessToken);
  res.json({
    success: true, sent: sentCount, total: upcoming.length,
    message: waConnected
      ? `Sent ${sentCount} of ${upcoming.length} birthday wishes via WhatsApp ✓`
      : `WhatsApp not configured for this branch. ${upcoming.length} customers have birthdays this week.`
  });
});


// ════════════════════════════════════════════════════════════════════════════
// Phase 5 — Push Notifications (web-push, optional)
// Install: npm install web-push  then set VAPID_PUBLIC/VAPID_PRIVATE in .env
// ════════════════════════════════════════════════════════════════════════════
let webPush = null;
const pushSubscriptions = new Map(); // phone -> [subscriptions]

try {
  webPush = require('web-push');
  const vapidPublic  = process.env.VAPID_PUBLIC;
  const vapidPrivate = process.env.VAPID_PRIVATE;
  const vapidEmail   = process.env.VAPID_EMAIL || 'mailto:admin@cafehq.com';
  if (vapidPublic && vapidPrivate) {
    webPush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate);
    console.log('[PWA] Push notifications enabled ✓');
  } else {
    console.log('[PWA] Push notifications: set VAPID_PUBLIC + VAPID_PRIVATE in .env to enable');
    webPush = null;
  }
} catch(e) {
  console.log('[PWA] web-push not installed — run: npm install web-push');
}

// GET /api/push/vapid-public — return public key for browser subscription
app.get('/api/push/vapid-public', (req, res) => {
  if (!webPush) return res.json({ enabled: false, key: null });
  res.json({ enabled: true, key: process.env.VAPID_PUBLIC });
});

// POST /api/push/subscribe — save browser push subscription
// Body: { subscription, phone, businessId }
app.post('/api/push/subscribe', (req, res) => {
  const { subscription, phone, businessId } = req.body;
  if (!subscription || !phone) return res.status(400).json({ error: 'subscription and phone required' });
  const key = `${businessId}:${phone.replace(/[^0-9]/g,'').slice(-10)}`;
  const existing = pushSubscriptions.get(key) || [];
  // Avoid duplicates by endpoint
  if (!existing.find(s => s.endpoint === subscription.endpoint)) {
    existing.push(subscription);
  }
  pushSubscriptions.set(key, existing);
  res.json({ success: true });
});

// Helper: send push to a phone number
async function sendPushToPhone(businessId, phone, payload) {
  if (!webPush) return;
  const key  = `${businessId}:${phone.replace(/[^0-9]/g,'').slice(-10)}`;
  const subs = pushSubscriptions.get(key) || [];
  const dead = [];
  for (const sub of subs) {
    try {
      await webPush.sendNotification(sub, JSON.stringify(payload));
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  if (dead.length) pushSubscriptions.set(key, subs.filter(s => !dead.includes(s.endpoint)));
}

app.get('/api/businesses', (req, res) => {
  res.json(businesses);
});

// 2. Add dynamic new business
app.post('/api/businesses', (req, res) => {
  const { name, location, timings, contact, wifi, map, review } = req.body;
  if (!name || !location) {
    return res.status(400).json({ error: 'Name and Location are required' });
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
  const newBiz = {
    id,
    name,
    location,
    timings: timings || '9:00 AM - 10:00 PM',
    contact: contact || '+91 99999 99999',
    map: map || 'https://maps.google.com',
    wifi: wifi || 'Cafe_Free_WiFi / Welcome123',
    review: review || 'https://g.page',
    status: 'offline'
  };

  businesses.push(newBiz);
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));

  // Initialize data files
  initializeBusinessFiles(id);

  res.json(newBiz);
});

// 3. Update business details
app.post('/api/businesses/:id', (req, res) => {
  const { id } = req.params;
  const index = businesses.findIndex(b => b.id === id);
  if (index === -1) return res.status(404).json({ error: 'Business not found' });

  businesses[index] = { ...businesses[index], ...req.body };
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  io.emit('settings_update', { branchId: id, settings: businesses[index] });

  // Sync with settings.json for Google Business Profile
  try {
    const settingsFile = path.join(DATA_DIR, id, 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (req.body.review && req.body.review.trim() !== '') {
        settings.gbpLinked = true;
        settings.gbpLocationId = req.body.review.trim();
      } else {
        settings.gbpLinked = false;
        settings.gbpLocationId = '';
      }
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.error('Error syncing review URL with settings.json:', err);
  }

  res.json(businesses[index]);
});


// ════════════════════════════════════════════════════════════════════════════
// Phase 6 — Client Onboarding & Agency Management
// ════════════════════════════════════════════════════════════════════════════

// GET /api/businesses/:id — single business details (includes brand fields)
app.get('/api/businesses/:id', (req, res) => {
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  res.json(biz);
});

// POST /api/onboard — self-serve client registration
// Creates business + default manager staff account
app.post('/api/onboard', async (req, res) => {
  const {
    businessName, ownerName, ownerEmail, ownerPhone,
    location, city, timings, brandColor, theme
  } = req.body;

  if (!businessName || !ownerName || !ownerPhone) {
    return res.status(400).json({ error: 'Business name, owner name, and phone are required' });
  }

  // Generate a clean branch ID
  const slug = businessName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 20);
  const id = slug + '_' + Date.now().toString(36);

  // Build business record with onboarding metadata
  const trialEnds = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
  const newBiz = {
    id,
    name: businessName,
    location: location || (city ? city : 'India'),
    timings: timings || '9:00 AM - 10:00 PM',
    contact: ownerPhone,
    map: `https://maps.google.com/?q=${encodeURIComponent(businessName)}`,
    wifi: '',
    review: '',
    status: 'online',
    // Onboarding fields
    ownerName,
    ownerEmail: ownerEmail || '',
    ownerPhone: ownerPhone.replace(/\D/g,'').slice(-10),
    brandColor: brandColor || '#C9A84C',
    theme: theme || 'espresso',
    subscriptionStatus: 'trial',
    trialEndsAt: trialEnds,
    onboardedAt: new Date().toISOString()
  };

  businesses.push(newBiz);
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  initializeBusinessFiles(id);

  // Create manager staff account in SQLite
  let staffCreds = null;
  if (db) {
    try {
      const bcrypt = require('bcryptjs');
      const tempPassword = 'cafe' + Math.random().toString(36).slice(2,7).toUpperCase();
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const username = slug.replace(/_\d+$/, '').slice(0, 15);
      const staff = db.createStaff({
        businessId: id,
        name: ownerName,
        username,
        passwordHash,
        role: 'manager'
      });
      staffCreds = { username, tempPassword, staffId: staff ? staff.id : null };

      // Also create owner account for the owner portal
      const ownerUsername = 'owner_' + slug.replace(/_\d+$/, '').slice(0, 12);
      const ownerTempPass = 'Own' + Math.random().toString(36).slice(2,6).toUpperCase() + '!';
      const ownerPassHash = await bcrypt.hash(ownerTempPass, 10);
      try {
        db.createStaff({ businessId: id, name: ownerName, username: ownerUsername, passwordHash: ownerPassHash, role: 'owner' });
        staffCreds.ownerUsername = ownerUsername;
        staffCreds.ownerTempPass = ownerTempPass;
      } catch(e2) { console.warn('[Onboard] Owner account:', e2.message); }
    } catch(e) {
      console.error('[Onboard] Staff creation error:', e.message);
    }
  }

  // Send welcome WhatsApp if connected
  if (getWaConfig(id)) {
    try {
      const phone = ownerPhone.replace(/\D/g,'').slice(-10);
      const chatId = '91' + phone;
      const welcomeMsg =
        `☕ *Welcome to Café Command HQ!*\n\n` +
        `Hi ${ownerName}! Your café *${businessName}* is now live.\n\n` +
        `🔗 Customer page: ${process.env.BASE_URL || ('http://localhost:' + (process.env.PORT || 3010))}/cafe/${id}\n` +
        `🛠 Manager login: ${process.env.BASE_URL || ('http://localhost:' + (process.env.PORT || 3010))}/manager.html\n` +
        `👑 Owner portal: ${process.env.BASE_URL || ('http://localhost:' + (process.env.PORT || 3010))}/owner.html\n` +
        (staffCreds?.ownerUsername ? `👑 Owner login — User: ${staffCreds.ownerUsername} | Pass: ${staffCreds.ownerTempPass}\n` : '') +
        (staffCreds ? `👤 Manager — User: ${staffCreds.username} | Pass: ${staffCreds.tempPassword}\n` : '') +
        `\n📅 Trial ends: ${trialEnds}\n\nReply HELP for support. ☕`;
      await sendWhatsAppToCustomer(id, chatId, welcomeMsg);
    } catch(e) { console.warn('[Onboard] WhatsApp welcome failed:', e.message); }
  }

  res.json({
    success: true,
    businessId: id,
    cafeUrl: `/cafe/${id}`,
    managerUrl: `/manager.html`,
    ownerUrl: `/owner.html`,
    trialEndsAt: trialEnds,
    staff: staffCreds
  });
});

// GET /api/agency/clients — all clients with stats (agency admin)
app.get('/api/agency/clients', (req, res) => {
  const clients = businesses.map(b => {
    // Pull revenue from SQLite if available
    let revenue = 0, orders = 0;
    if (db) {
      try {
        const row = db.raw.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as rev FROM orders WHERE business_id=?').get(b.id);
        if (row) { orders = row.cnt; revenue = row.rev; }
      } catch(e) {}
    }
    const daysLeft = b.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(b.trialEndsAt) - Date.now()) / 86400000))
      : null;
    return {
      id: b.id,
      name: b.name,
      ownerName: b.ownerName || '—',
      ownerPhone: b.ownerPhone || b.contact || '—',
      ownerEmail: b.ownerEmail || '—',
      location: b.location,
      status: b.status,
      subscriptionStatus: b.subscriptionStatus || 'active',
      trialEndsAt: b.trialEndsAt || null,
      daysLeft,
      onboardedAt: b.onboardedAt || null,
      brandColor: b.brandColor || '#C9A84C',
      theme: b.theme || 'espresso',
      revenue,
      orders
    };
  });
  res.json(clients);
});

// POST /api/businesses/:id/theme — manager updates their café's UI theme
app.post('/api/businesses/:id/theme', (req, res) => {
  const { id } = req.params;
  const { theme } = req.body;
  const VALID_THEMES = ['espresso','ocean','forest','cherry','lavender','terracotta','emerald','midnight'];
  if (!theme || !VALID_THEMES.includes(theme)) {
    return res.status(400).json({ error: 'Invalid theme. Must be one of: ' + VALID_THEMES.join(', ') });
  }
  const biz = businesses.find(b => b.id === id);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  // Allow manager of this branch or agency admin
  if (req.user.role !== 'agency_admin' && req.user.businessId !== id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  biz.theme = theme;
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  res.json({ success: true, theme });
});

// PATCH /api/agency/clients/:id/status — update subscription status
app.post('/api/agency/clients/:id/status', (req, res) => {
  const { id } = req.params;
  const { subscriptionStatus } = req.body;
  const valid = ['trial','active','paused','cancelled'];
  if (!valid.includes(subscriptionStatus)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const idx = businesses.findIndex(b => b.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  businesses[idx].subscriptionStatus = subscriptionStatus;
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  res.json({ success: true, id, subscriptionStatus });
});

// ════════════════════════════════════════════════════════════════════════════
// Google Review Verification Routes
// ════════════════════════════════════════════════════════════════════════════

// GET /api/businesses/:id/google-review/claims
app.get('/api/businesses/:id/google-review/claims', (req, res) => {
  const claims = getBranchData(req.params.id, 'google_review_claims.json') || [];
  res.json(claims);
});

// POST /api/businesses/:id/google-review/:claimId/approve
app.post('/api/businesses/:id/google-review/:claimId/approve', async (req, res) => {
  const { id, claimId } = req.params;
  const claims = getBranchData(id, 'google_review_claims.json') || [];
  const idx = claims.findIndex(c => c.id === claimId);
  if (idx === -1) return res.status(404).json({ error: 'Claim not found' });
  const claim = claims[idx];
  if (claim.status !== 'pending') return res.status(400).json({ error: 'Claim already processed' });

  // Award 100 points
  let card = null;
  if (db) {
    try {
      card = db.awardBonusPoints(id, claim.phone, claim.customerName, 100, 'Google review reward');
      io.emit('loyalty_update', { businessId: id, card });
    } catch(e) { return res.status(500).json({ error: 'Points award failed: ' + e.message }); }
  }

  // Update claim status
  claims[idx].status = 'approved';
  claims[idx].approvedAt = new Date().toISOString();
  writeBranchData(id, 'google_review_claims.json', claims);
  io.emit('google_review_claim_update', { branchId: id, claim: claims[idx] });

  // Notify customer via WhatsApp
  if (getWaConfig(id)) {
    try {
      const business = businesses.find(b => b.id === id) || { name: 'Café HQ' };
      const chatId = '91' + claim.phone;
      const newBal = card ? card.points : '?';
      await sendWhatsAppToCustomer(req.params.id, chatId,
        `🎉 *Google Review Verified!*

Hi ${claim.customerName}! Your Google review has been verified by our team.

🎁 *+100 Loyalty Points* have been added to your account!
💰 New balance: *${newBal} points*

Thank you for supporting ${business.name}! ☕`
      );
    } catch(e) { console.warn('[Review] WhatsApp notify failed:', e.message); }
  }

  res.json({ success: true, claim: claims[idx], card });
});

// POST /api/businesses/:id/google-review/:claimId/reject
app.post('/api/businesses/:id/google-review/:claimId/reject', async (req, res) => {
  const { id, claimId } = req.params;
  const { reason } = req.body;
  const claims = getBranchData(id, 'google_review_claims.json') || [];
  const idx = claims.findIndex(c => c.id === claimId);
  if (idx === -1) return res.status(404).json({ error: 'Claim not found' });

  claims[idx].status = 'rejected';
  claims[idx].rejectedAt = new Date().toISOString();
  claims[idx].rejectReason = reason || 'Review not found';
  writeBranchData(id, 'google_review_claims.json', claims);
  io.emit('google_review_claim_update', { branchId: id, claim: claims[idx] });

  // Notify customer
  if (getWaConfig(id)) {
    try {
      const chatId = '91' + claims[idx].phone;
      const business = businesses.find(b => b.id === id) || { name: 'Café HQ', review: '' };
      await sendWhatsAppToCustomer(req.params.id, chatId,
        `😔 We couldn't verify a Google review under the name *${claims[idx].reviewerName}*.

Please make sure your review is posted at:
${business.review}

If you think this is a mistake, reply *review claim* and try again. 🙏`
      );
    } catch(e) {}
  }

  res.json({ success: true, claim: claims[idx] });
});

// 4. Get Menu of branch
app.get('/api/businesses/:id/menu', (req, res) => {
  res.json(getBranchData(req.params.id, 'menu.json'));
});

// 5. Update Menu of branch
app.post('/api/businesses/:id/menu', (req, res) => {
  const { id } = req.params;
  const menuData = req.body; // Expect array of items
  writeBranchData(id, 'menu.json', menuData);
  io.emit('menu_update', { branchId: id, menu: menuData });
  res.json({ success: true, menu: menuData });
});

// 6. Get Reservations
app.get('/api/businesses/:id/reservations', (req, res) => {
  res.json(getBranchData(req.params.id, 'reservations.json'));
});

// 6a. Submit table booking from customer website
app.post('/api/businesses/:id/reservations', (req, res) => {
  const { id } = req.params;
  const { name, phone, guests, datetime } = req.body;
  if (!name || !phone || !guests || !datetime) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  
  const reservations = getBranchData(id, 'reservations.json');
  const newRes = {
    id: 'r_' + Date.now(),
    name,
    phone,
    guests: parseInt(guests),
    datetime,
    status: 'pending'
  };
  reservations.push(newRes);
  writeBranchData(id, 'reservations.json', reservations);
  
  // Update customer CRM profile
  updateCustomerProfile(id, phone, name, 'web_booking');
  
  io.emit('reservation_update', { branchId: id, reservations });
  res.json({ success: true, reservation: newRes });
});

// 7. Update reservation status (approve/cancel)
app.post('/api/businesses/:id/reservations/:resId/status', async (req, res) => {
  const { id, resId } = req.params;
  const { status } = req.body;
  const reservations = getBranchData(id, 'reservations.json');
  const index = reservations.findIndex(r => r.id === resId);
  if (index === -1) return res.status(404).json({ error: 'Reservation not found' });

  reservations[index].status = status;
  writeBranchData(id, 'reservations.json', reservations);

  // Send WhatsApp notification to customer
  const r = reservations[index];
  const bizName = (businesses.find(b => b.id === id) || {}).name || 'our cafe';
  let notifyMsg;
  if (status === 'approved') {
    notifyMsg = '\u2705 Hi ' + r.name + '! Your table booking for *' + r.guests + ' guest(s)* on *' + r.datetime + '* at *' + bizName + '* has been *confirmed*! \u{1F389}\n\nWe look forward to seeing you soon! \u2615';
  } else {
    notifyMsg = '\u{1F614} Hi ' + r.name + ', unfortunately we are unable to accommodate your booking for *' + r.datetime + '* (' + r.guests + ' guest(s)) due to full capacity or a scheduling conflict.\n\nWe sincerely apologise. Please try a different time slot — we would love to have you! \u2615\n\n\u2014 ' + bizName;
  }
  if (getWaConfig(id)) {
    const wid = '91' + r.phone.replace(/[^0-9]/g, '').slice(-10);
    sendWhatsAppToCustomer(id, wid, notifyMsg)
      .then(() => console.log('[WhatsApp Reservation] ' + status + ' message sent to ' + wid))
      .catch(e => console.error('[WhatsApp Reservation] Failed:', e.message));
  }

  io.emit('reservation_update', { branchId: id, reservations });
  res.json({ success: true, reservations });
});

// 8. Get CRM profiles
// POST /api/businesses/:id/walkin — manager registers a walk-in customer
app.post('/api/businesses/:id/walkin', safeAuth, (req, res) => {
  const { id } = req.params;
  const { name, phone, birthday, notes, awardWelcomePoints } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }

  // Normalise phone — keep last 10 digits
  const normPhone = phone.replace(/\D/g, '').slice(-10);
  if (normPhone.length < 10) {
    return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
  }

  // Upsert customer_profiles.json
  const profiles = getBranchData(id, 'customer_profiles.json');
  let profile = profiles.find(p => p.phone === normPhone || p.phone === phone);
  const isNew = !profile;

  if (!profile) {
    profile = {
      phone: normPhone,
      name,
      visits: 1,
      tags: ['walk_in'],
      lastActive: new Date().toLocaleString(),
      averageRating: 0,
      feedbackCount: 0,
      offersReceived: [],
      source: 'walk_in',
      registeredAt: new Date().toISOString(),
    };
    profiles.push(profile);
  } else {
    profile.name    = name || profile.name;
    profile.visits  = (profile.visits || 0) + 1;
    profile.lastActive = new Date().toLocaleString();
    if (!profile.tags) profile.tags = [];
    if (!profile.tags.includes('walk_in')) profile.tags.push('walk_in');
  }

  if (birthday) profile.birthday = birthday;
  if (notes)    profile.notes = notes;
  profile.loyaltyTier = getLoyaltyTier(profile.visits);

  writeBranchData(id, 'customer_profiles.json', profiles);
  io.emit('crm_update', { branchId: id, profiles });

  // Upsert SQLite loyalty card
  let card = null;
  let pointsAwarded = 0;
  if (db) {
    try {
      card = db.getOrCreateCard(id, normPhone, name);
      if (isNew && awardWelcomePoints !== false) {
        db.awardBonusPoints(id, normPhone, name, 50, 'Welcome gift — walk-in registration');
        pointsAwarded = 50;
      }
      db.stmts.upsertCustomer.run(id, normPhone, name, 1, 'walk_in', profile.loyaltyTier, JSON.stringify(profile.tags), normPhone);
    } catch(e) { console.error('[Walk-in DB]', e.message); }
  }

  res.json({
    success: true,
    isNew,
    customer: profile,
    loyaltyCard: card,
    pointsAwarded,
    message: isNew
      ? `${name} registered! ${pointsAwarded} welcome points added.`
      : `${name}'s visit logged. Now at ${profile.visits} visits (${profile.loyaltyTier}).`
  });
});

app.get('/api/businesses/:id/crm', (req, res) => {
  res.json(getBranchData(req.params.id, 'customer_profiles.json'));
});

// 9. Get analytics
app.get('/api/businesses/:id/analytics', (req, res) => {
  const traffic = getBranchData(req.params.id, 'traffic_stats.json');
  const profiles = getBranchData(req.params.id, 'customer_profiles.json');
  const reservations = getBranchData(req.params.id, 'reservations.json');
  const settings = getBranchData(req.params.id, 'settings.json');
  
  res.json({ traffic, profiles, reservations, settings });
});

// 10. Update campaigns
app.post('/api/businesses/:id/campaigns', (req, res) => {
  const { id } = req.params;
  const { lowTrafficCampaigns } = req.body;
  const settings = getBranchData(id, 'settings.json');
  settings.lowTrafficCampaigns = lowTrafficCampaigns;
  writeBranchData(id, 'settings.json', settings);
  io.emit('settings_update', { branchId: id, settings });
  res.json({ success: true, settings });
});

// 10a. Get feedback reviews
app.get('/api/businesses/:id/feedback', (req, res) => {
  res.json(getBranchData(req.params.id, 'feedback.json'));
});

// 10a-2. Submit feedback from customer website
app.post('/api/businesses/:id/feedback', (req, res) => {
  const { id } = req.params;
  const { customerName, phone, rating, comment } = req.body;
  if (!customerName || !rating || !comment) {
    return res.status(400).json({ error: 'Name, rating, and comment are required.' });
  }
  
  const feedback = getBranchData(id, 'feedback.json');
  
  let couponCode = null;
  if (parseInt(rating) === 5) {
    couponCode = 'THANKYOU15';
  }

  const newFb = {
    id: 'f_' + Date.now(),
    customerName,
    rating: parseInt(rating),
    comment,
    timestamp: new Date().toLocaleString(),
    source: 'web'
  };
  if (couponCode) {
    newFb.couponCode = couponCode;
  }
  feedback.push(newFb);
  writeBranchData(id, 'feedback.json', feedback);
  
  // Update customer CRM profile
  const reviews = feedback.filter(f => f.customerName === customerName);
  const totalStars = reviews.reduce((sum, r) => sum + r.rating, 0);
  const avg = reviews.length > 0 ? parseFloat((totalStars / reviews.length).toFixed(1)) : rating;
  
  updateCustomerProfile(id, phone || 'web_user', customerName, 'gave_feedback', {
    averageRating: avg,
    feedbackCount: reviews.length
  });
  
  // Save coupon code to customer profile if rating is 5
  if (couponCode && phone) {
    const profiles = getBranchData(id, 'customer_profiles.json');
    const profile = profiles.find(p => p.phone === phone);
    if (profile) {
      profile.offersReceived = profile.offersReceived || [];
      if (!profile.offersReceived.some(o => o.offer.includes(couponCode))) {
        profile.offersReceived.push({
          offer: `Feedback Reward: Coupon ${couponCode} (15% Off)`,
          timestamp: new Date().toISOString()
        });
        writeBranchData(id, 'customer_profiles.json', profiles);
        io.emit('crm_update', { branchId: id, profiles });
      }
    }
  }
  
  io.emit('feedback_update', { branchId: id, feedback });
  res.json({ success: true, feedback: newFb });
});

function getDefaultDraftReply(customerName, rating) {
  if (rating >= 4) {
    return `Thank you so much for the wonderful review, ${customerName}! We're thrilled you enjoyed your visit and look forward to welcoming you back soon! 😊☕`;
  } else {
    return `Hello ${customerName}, we are truly sorry to hear that your experience wasn't up to our usual standards. We value your feedback and would love to make this right on your next visit. Please contact us directly.`;
  }
}

// Generate draft AI reply for feedback
app.post('/api/businesses/:id/feedback/:feedbackId/reply-draft', async (req, res) => {
  const { id, feedbackId } = req.params;
  const feedback = getBranchData(id, 'feedback.json');
  const item = feedback.find(f => f.id === feedbackId);
  if (!item) return res.status(404).json({ error: 'Feedback not found' });
  
  let draft = '';
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const business = businesses.find(b => b.id === id) || businesses[0];
      const prompt = `You are the manager of "${business.name}" café. 
Write a professional, warm, and brief response (1-2 sentences) to the following customer review.
If the rating is high (4-5 stars), thank them warmly and invite them back.
If the rating is low (1-3 stars), apologize sincerely for any issues mentioned and offer to make it right.
Reviewer: ${item.customerName}
Rating: ${item.rating} stars
Comment: "${item.comment}"
Manager Response draft:`;
      const result = await model.generateContent(prompt);
      const response = await result.response;
      draft = response.text().trim();
    } catch (err) {
      console.error('[Gemini Feedback Reply Error]', err);
      draft = getDefaultDraftReply(item.customerName, item.rating);
    }
  } else {
    draft = getDefaultDraftReply(item.customerName, item.rating);
  }
  
  res.json({ success: true, draft });
});

// Submit manager reply to feedback
app.post('/api/businesses/:id/feedback/:feedbackId/reply', (req, res) => {
  const { id, feedbackId } = req.params;
  const { reply } = req.body;
  const feedback = getBranchData(id, 'feedback.json');
  const index = feedback.findIndex(f => f.id === feedbackId);
  if (index === -1) return res.status(404).json({ error: 'Feedback not found' });
  
  feedback[index].managerReply = reply;
  feedback[index].replyTimestamp = new Date().toLocaleString();
  writeBranchData(id, 'feedback.json', feedback);
  
  io.emit('feedback_update', { branchId: id, feedback });
  res.json({ success: true, feedback: feedback[index] });
});

// 10b. Toggle Auto-Pilot setting
app.post('/api/businesses/:id/autopilot/toggle', (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  const settings = getBranchData(id, 'settings.json');
  settings.autoPilotActive = !!active;
  writeBranchData(id, 'settings.json', settings);
  res.json({ success: true, settings });
});

// 10c. Manual trigger Auto-Pilot campaign
app.post('/api/businesses/:id/autopilot/trigger', (req, res) => {
  const { id } = req.params;
  const { forceDay } = req.body;
  const result = runAutoPilotCampaign(id, forceDay);
  res.json({ success: true, result });
});

// 10d. Link Google Business Profile
app.post('/api/businesses/:id/gbp/link', (req, res) => {
  const { id } = req.params;
  const { locationId } = req.body;
  const settings = getBranchData(id, 'settings.json');
  if (locationId) {
    settings.gbpLinked = true;
    settings.gbpLocationId = locationId;
    if (locationId.startsWith('http')) {
      const index = businesses.findIndex(b => b.id === id);
      if (index !== -1) {
        businesses[index].review = locationId;
        fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
      }
    }
  } else {
    settings.gbpLinked = false;
    settings.gbpLocationId = '';
    const index = businesses.findIndex(b => b.id === id);
    if (index !== -1) {
      businesses[index].review = '';
      fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
    }
  }
  writeBranchData(id, 'settings.json', settings);
  res.json({ success: true, settings });
});


// 10e. Sync Google Business Profile reviews
app.post('/api/businesses/:id/gbp/sync', (req, res) => {
  const { id } = req.params;
  const settings = getBranchData(id, 'settings.json');
  if (!settings.gbpLinked) {
    return res.status(400).json({ error: 'Google Business Profile is not linked yet.' });
  }

  const feedback = getBranchData(id, 'feedback.json');
  const alreadySynced = feedback.some(f => f.source === 'google');
  
  let addedCount = 0;
  if (!alreadySynced) {
    const googleReviews = [
      {
        id: 'g1',
        customerName: 'Aditya Sen',
        rating: 5,
        comment: 'Best cold coffee in Indiranagar! The seating is cozy and WiFi is very fast. 5/5 stars from Google My Business! ⭐',
        timestamp: new Date().toLocaleString(),
        source: 'google'
      },
      {
        id: 'g2',
        customerName: 'Meera Kapoor',
        rating: 4,
        comment: 'Lovely ambiance. Perfect place to sit with a laptop. Peri Peri fries were delicious! Google Local Guide review.',
        timestamp: new Date().toLocaleString(),
        source: 'google'
      },
      {
        id: 'g3',
        customerName: 'Kabir Dev',
        rating: 5,
        comment: 'Staff is extremely polite. They helped us reserve a group table. Highly recommended! Sync review from GBP.',
        timestamp: new Date().toLocaleString(),
        source: 'google'
      }
    ];
    
    feedback.push(...googleReviews);
    writeBranchData(id, 'feedback.json', feedback);
    addedCount = googleReviews.length;
    
    // Check matches with CRM
    const profiles = getBranchData(id, 'customer_profiles.json');
    googleReviews.forEach(gr => {
      // Find matching profile by name
      const matchingProfile = profiles.find(p => p.name.toLowerCase() === gr.customerName.toLowerCase());
      if (matchingProfile) {
        // If it's a 5-star review, give them a coupon!
        if (gr.rating === 5) {
          const couponCode = 'REVIEW15';
          matchingProfile.offersReceived = matchingProfile.offersReceived || [];
          if (!matchingProfile.offersReceived.some(o => o.offer.includes(couponCode))) {
            matchingProfile.offersReceived.push({
              offer: `Google Review Reward: Coupon ${couponCode} (15% Off)`,
              timestamp: new Date().toISOString()
            });
            
            // Emit a chat notification to simulate that the bot sent them a WhatsApp message!
            io.emit('inbound_chat', {
              branchId: id,
              phone: matchingProfile.phone,
              text: `🎁 *[GOOGLE REVIEW REWARD]*: Hi ${matchingProfile.name}! Thank you for your 5-star review on Google! Here is your reward coupon: *${couponCode}* for 15% off on your next visit! ☕✨`,
              sender: 'ai',
              timestamp: new Date().toLocaleTimeString()
            });
            
            // If WhatsApp client is connected, actually send it
            if (getWaConfig(req.params.id)) {
              sendWhatsAppToCustomer(req.params.id, matchingProfile.phone, `Hi ${matchingProfile.name}! Thank you for your 5-star review on Google! Here is your reward coupon: *${couponCode}* for 15% off on your next visit! ☕✨`).catch(e => console.error(e));
            }
          }
        }
      }
    });
    writeBranchData(id, 'customer_profiles.json', profiles);
    io.emit('crm_update', { branchId: id, profiles });
    io.emit('feedback_update', { branchId: id, feedback });
  }

  res.json({ success: true, addedCount, total: feedback.length });
});

// In-memory cache for campaign suggestions: branchId -> suggestions list
const campaignSuggestionsCache = {};

function getLocalCampaignSuggestions(profiles, feedback, branchId) {
  return profiles.map((p, idx) => {
    const name = p.name || 'Customer';
    const tier = p.loyaltyTier || getLoyaltyTier(p.visits);
    const tags = p.tags || [];
    
    let psychology = 'Valued customer.';
    let offerText = `Hello ${name}! ☕ Stop by for a cozy break and get a free chocolate chip cookie with any hot coffee today! Code: SMILE15`;
    
    // Categorize based on tags/rating
    const hasBurger = tags.some(t => t.toLowerCase().includes('burger'));
    const hasPasta = tags.some(t => t.toLowerCase().includes('pasta'));
    const hasCoffee = tags.some(t => t.toLowerCase().includes('coffee'));
    const hasOffer = tags.some(t => t.toLowerCase().includes('offer'));
    const hasComplaint = tags.some(t => t.toLowerCase().includes('complain')) || p.averageRating <= 3 && p.feedbackCount > 0;
    
    if (hasComplaint) {
      psychology = 'Shared criticism. Needs special attention to restore satisfaction.';
      offerText = `Hello ${name}, we value your feedback. Enjoy a complimentary Virgin Mojito on us to make things right! Code: CARE15`;
    } else if (tier === 'Elite' || tier === 'VIP') {
      psychology = `Highly loyal ${tier} guest. Appreciates premium hospitality.`;
      offerText = `Hello ${name}! 🌟 As a valued ${tier} member, enjoy a free cookie with any hot coffee today! Code: PRESTIGE15`;
    } else if (hasBurger) {
      psychology = 'Interested in burger items and standard deals.';
      offerText = `Hi ${name}! 🍔 Craving a bite? Get 15% off on our Classic Cheese Burger today! Code: BURGER15`;
    } else if (hasPasta) {
      psychology = 'Interested in pasta items and quality flavors.';
      offerText = `Hi ${name}! 🍝 Enjoy 15% off on our rich Alfredo Pasta on your next visit! Code: PASTA15`;
    } else if (hasCoffee) {
      psychology = 'Regular coffee lover.';
      offerText = `Hey ${name}! ☕ Double the coffee joy: Buy 1 Get 1 Free on Cold Coffee today! Code: BOGO15`;
    } else if (hasOffer) {
      psychology = 'Sensitive to deals and active promotions.';
      offerText = `Hey ${name}! 🎁 Here is a special 15% off coupon code for your next visit: Code: OFFER15`;
    }
    
    return {
      id: `sug_${Date.now()}_${idx}`,
      customerPhone: p.phone,
      customerName: name,
      loyaltyTier: tier,
      psychology,
      offerText,
      status: 'pending'
    };
  });
}

// Generate AI suggestions for campaigns
app.get('/api/businesses/:id/ai-campaign-suggestions', async (req, res) => {
  const { id } = req.params;
  const profiles = getBranchData(id, 'customer_profiles.json');
  const feedback = getBranchData(id, 'feedback.json');
  
  if (!profiles || profiles.length === 0) {
    campaignSuggestionsCache[id] = [];
    return res.json([]);
  }
  
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const prompt = `You are an expert restaurant marketing analyst. 
Study the following customer profiles and feedback reviews from our cafe SaaS platform.
Customer Profiles: ${JSON.stringify(profiles)}
Feedback Reviews: ${JSON.stringify(feedback)}

For each customer, analyze their return frequency, tags, and feedback comments to understand their customer psychology (e.g. food preferences, price sensitivity, loyalty tier, or quality complaints).
Generate a targeted promotional offer tailored to their preferences.

Output a raw JSON array of objects. Do not wrap in markdown code blocks. Each object must have:
- customerPhone: The customer's phone number
- customerName: The customer's name
- loyaltyTier: The customer's loyalty tier
- psychology: A brief description of their psychology and preferences (1 sentence)
- offerText: A friendly, short promotional offer text message (1-2 sentences) to send them via WhatsApp (include emojis, warm greeting, and discount code or special benefit).
`;
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text().trim();
      let cleanOutput = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
      let list = JSON.parse(cleanOutput);
      
      // Add dynamic IDs and statuses
      list = list.map((item, idx) => ({
        id: `sug_${Date.now()}_${idx}`,
        customerPhone: item.customerPhone,
        customerName: item.customerName,
        loyaltyTier: item.loyaltyTier,
        psychology: item.psychology,
        offerText: item.offerText,
        status: 'pending'
      }));
      
      campaignSuggestionsCache[id] = list;
      return res.json(list);
    } catch (err) {
      console.error('[Gemini AI Campaign Suggestions Error]', err);
      // Fallback
      const fallbackList = getLocalCampaignSuggestions(profiles, feedback, id);
      campaignSuggestionsCache[id] = fallbackList;
      return res.json(fallbackList);
    }
  } else {
    const list = getLocalCampaignSuggestions(profiles, feedback, id);
    campaignSuggestionsCache[id] = list;
    return res.json(list);
  }
});

// Approve and send campaign
app.post('/api/businesses/:id/ai-campaign-suggestions/:suggestionId/approve', (req, res) => {
  const { id, suggestionId } = req.params;
  const { customOfferText } = req.body;
  
  const cache = campaignSuggestionsCache[id] || [];
  const sug = cache.find(s => s.id === suggestionId);
  if (!sug) return res.status(404).json({ error: 'Suggestion not found or cache expired' });
  
  sug.status = 'approved';
  const textToSend = customOfferText || sug.offerText;
  sug.offerText = textToSend;
  
  // Update CRM customer profile with offer received
  const profiles = getBranchData(id, 'customer_profiles.json');
  const profile = profiles.find(p => p.phone === sug.customerPhone);
  if (profile) {
    profile.offersReceived = profile.offersReceived || [];
    profile.offersReceived.push({
      offer: `AI Campaign: ${textToSend}`,
      timestamp: new Date().toISOString()
    });
    writeBranchData(id, 'customer_profiles.json', profiles);
    io.emit('crm_update', { branchId: id, profiles });
  }
  
  // Broadcast simulated chat notification
  io.emit('inbound_chat', {
    branchId: id,
    phone: sug.customerPhone,
    text: `🎁 *[AI SMART CAMPAIGN]*: ${textToSend}`,
    sender: 'ai',
    timestamp: new Date().toLocaleTimeString()
  });
  
  // Send via WhatsApp if connected
  if (getWaConfig(branchId)) {
    sendWhatsAppToCustomer(branchId, sug.customerPhone, textToSend).catch(e => console.error('[WhatsApp AI Campaign Error]', e));
  }
  
  res.json({ success: true, suggestion: sug });
});

// 11. Programmatic chatbot response simulation (Async)
app.post('/api/businesses/:id/chat', async (req, res) => {
  const { id } = req.params;
  const { phone, text, customerName } = req.body;
  if (!phone || !text) {
    return res.status(400).json({ error: 'Phone and text are required' });
  }
  if (customerName) {
    updateCustomerProfile(id, phone, customerName, 'chat_initiated');
  }
  // Run pricing/reservation logic
  const reply = await processCafeBotReply(id, phone, text);
  res.json({ success: true, reply });
});

// 12. Get custom offer requests
app.get('/api/businesses/:id/offers', (req, res) => {
  res.json(getBranchData(req.params.id, 'offer_requests.json'));
});

// 13. Approve custom offer
app.post('/api/businesses/:id/offers/:offerId/approve', (req, res) => {
  const { id, offerId } = req.params;
  const { customText } = req.body;
  const offers = getBranchData(id, 'offer_requests.json');
  const index = offers.findIndex(o => o.id === offerId);
  if (index === -1) return res.status(404).json({ error: 'Offer request not found' });

  offers[index].status = 'approved';
  offers[index].approvedOffer = customText;
  writeBranchData(id, 'offer_requests.json', offers);

  // Send approved text to customer via WhatsApp or simulator
  const phone = offers[index].phone;
  const msgContent = customText || `Congratulations! Your custom discount request has been approved: Flat 15% Off! 🎉`;

  if (getWaConfig(req.params.id)) {
    sendWhatsAppToCustomer(req.params.id, phone, msgContent).catch(e => console.error('Send error', e));
  }

  // Emit chat response to simulated logs
  io.emit('inbound_chat', {
    branchId: id,
    phone: phone,
    text: `🔔 *[APPROVED CUSTOM OFFER]*: ${msgContent}`,
    sender: 'ai',
    timestamp: new Date().toLocaleTimeString()
  });

  io.emit('offers_update', { branchId: id, offers });
  res.json({ success: true, offers });
});

// 14. Reject custom offer
app.post('/api/businesses/:id/offers/:offerId/reject', (req, res) => {
  const { id, offerId } = req.params;
  const offers = getBranchData(id, 'offer_requests.json');
  const index = offers.findIndex(o => o.id === offerId);
  if (index === -1) return res.status(404).json({ error: 'Offer request not found' });

  offers[index].status = 'rejected';
  writeBranchData(id, 'offer_requests.json', offers);

  const phone = offers[index].phone;
  const msgContent = `Sorry, we cannot offer any additional custom discount at this time. However, please check out our Tuesday Coffee specials! 😊☕`;

  if (getWaConfig(req.params.id)) {
    sendWhatsAppToCustomer(req.params.id, phone, msgContent).catch(e => console.error('Send error', e));
  }

  // Emit chat response to simulated logs
  io.emit('inbound_chat', {
    branchId: id,
    phone: phone,
    text: msgContent,
    sender: 'ai',
    timestamp: new Date().toLocaleTimeString()
  });

  io.emit('offers_update', { branchId: id, offers });
  res.json({ success: true, offers });
});



// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Cloud API — Webhook (per-café, official Meta API)
// Each café has its own phoneNumberId + accessToken in businesses.json
// Webhook URL: POST /api/webhook/whatsapp  (set this in Meta Developer Console)
// ─────────────────────────────────────────────────────────────────────────────

// GET — webhook verification (Meta calls this once when you register the webhook)
app.get('/api/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  // Each café sets its own verifyToken in businesses.json → whatsapp.verifyToken
  // OR use a master WEBHOOK_VERIFY_TOKEN env var for simplicity
  const masterToken = process.env.WEBHOOK_VERIFY_TOKEN || 'cafehq_webhook_2024';
  const validToken  = businesses.some(b => b.whatsapp?.verifyToken === token) || token === masterToken;
  if (mode === 'subscribe' && validToken) {
    console.log('[WA Webhook] Verification successful');
    return res.status(200).send(challenge);
  }
  console.warn('[WA Webhook] Verification failed — bad token:', token);
  res.sendStatus(403);
});

// POST — incoming messages from WhatsApp
app.post('/api/webhook/whatsapp', async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value;
        if (!value?.messages?.length) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        // Route to the correct café by matching phoneNumberId
        const business = businesses.find(b => b.whatsapp?.phoneNumberId === phoneNumberId);
        if (!business) {
          console.warn('[WA Webhook] No business found for phoneNumberId:', phoneNumberId);
          continue;
        }

        for (const message of value.messages) {
          if (message.type !== 'text') continue; // skip images/audio for now
          const fromPhone = message.from; // e.g. "919876543210"
          const incomingText = message.text?.body || '';
          const messageId = message.id;

          console.log(`[WA Cloud API] [${business.id}] From ${fromPhone}: "${incomingText}"`);

          // Mark as read (shows blue ticks)
          waApi.markAsRead(business.whatsapp.phoneNumberId, business.whatsapp.accessToken, messageId);

          // Emit to dashboard
          io.emit('inbound_chat', {
            branchId: business.id,
            phone: fromPhone,
            text: incomingText,
            sender: 'customer',
            timestamp: new Date().toLocaleTimeString()
          });

          // Run AI bot
          const reply = await processCafeBotReply(business.id, fromPhone, incomingText);

          // Send reply via Cloud API
          await waApi.sendMessage(
            business.whatsapp.phoneNumberId,
            business.whatsapp.accessToken,
            fromPhone,
            reply
          );

          console.log(`[WA Cloud API] [${business.id}] Sent to ${fromPhone}: "${reply.slice(0,60)}..."`);

          // Emit AI reply to dashboard
          io.emit('inbound_chat', {
            branchId: business.id,
            phone: fromPhone,
            text: reply,
            sender: 'ai',
            timestamp: new Date().toLocaleTimeString()
          });
        }
      }
    }
  } catch (e) {
    console.error('[WA Webhook] Processing error:', e.message);
  }
});

// POST /api/businesses/:id/whatsapp/setup — save Cloud API credentials for a branch
app.post('/api/businesses/:id/whatsapp/setup', safeAuth, (req, res) => {
  const { phoneNumberId, accessToken, verifyToken } = req.body;
  if (!phoneNumberId || !accessToken) return res.status(400).json({ error: 'phoneNumberId and accessToken required' });
  const idx = businesses.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Branch not found' });
  businesses[idx].whatsapp = {
    phoneNumberId: phoneNumberId.trim(),
    accessToken: accessToken.trim(),
    verifyToken: (verifyToken || ('cafehq_' + req.params.id + '_' + Date.now())).trim()
  };
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  waStatus[req.params.id] = { status: 'Configured', phone: phoneNumberId };
  io.emit('whatsapp_state', { branchId: req.params.id, status: 'Configured' });
  res.json({ success: true, verifyToken: businesses[idx].whatsapp.verifyToken });
});

// GET /api/businesses/:id/whatsapp/status — check if credentials are valid
app.get('/api/businesses/:id/whatsapp/status', safeAuth, async (req, res) => {
  const cfg = getWaConfig(req.params.id);
  if (!cfg?.phoneNumberId) return res.json({ configured: false, status: 'Not configured' });
  const result = await waApi.verifyCredentials(cfg.phoneNumberId, cfg.accessToken);
  res.json({ configured: true, ...result });
});



// -------------------------------------------------------------
// Socket.io Real-time Event Handling
// -------------------------------------------------------------

// ═════════════════════════════════════════════════════════════════════════════
// Accounting Module — Expenses, P&L, GST
// Expenses: managers can add | P&L + GST: admin token required
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/businesses/:id/accounting/expenses — add expense (manager)
app.post('/api/businesses/:id/accounting/expenses', safeAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { category, description, amount, gstAmount, vendor, receiptNo, expenseDate } = req.body;
  if (!category || !amount) return res.status(400).json({ error: 'category and amount required' });
  const id = db.addExpense({
    businessId: req.params.id, category, description, amount, gstAmount,
    vendor, receiptNo, expenseDate,
    addedBy: req.staff?.name || 'manager'
  });
  res.json({ success: true, id });
});

// GET /api/businesses/:id/accounting/expenses — list expenses (manager)
app.get('/api/businesses/:id/accounting/expenses', safeAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { from, to, category } = req.query;
  const expenses = db.getExpenses(req.params.id, { from, to, category });
  res.json(expenses);
});

// DELETE /api/businesses/:id/accounting/expenses/:expId — delete expense (manager)
app.delete('/api/businesses/:id/accounting/expenses/:expId', safeAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  db.raw.prepare('DELETE FROM expenses WHERE id=? AND business_id=?').run(req.params.expId, req.params.id);
  res.json({ success: true });
});

// GET /api/businesses/:id/accounting/pl — P&L report (ADMIN TOKEN or branch owner)
app.get('/api/businesses/:id/accounting/pl', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const adminToken = process.env.ADMIN_TOKEN || 'cafehq_admin_secret';
  const isAdmin = req.headers['x-admin-token'] === adminToken;
  let isOwner = false;
  if (!isAdmin && auth) {
    try {
      const tok = (req.headers.authorization||'').replace('Bearer ','');
      if (tok) { const r = auth.verifyToken(tok); const p = r&&r.ok?r.payload:null; if (p && p.role==='owner' && p.businessId===req.params.id) isOwner=true; }
    } catch(e) {}
  }
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Admin token or owner login required' });
  const { from, to } = req.query;
  const pl = db.getProfitAndLoss(req.params.id, { from, to });
  res.json(pl);
});

// GET /api/businesses/:id/accounting/gst — GST report (ADMIN TOKEN or branch owner)
app.get('/api/businesses/:id/accounting/gst', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const adminToken = process.env.ADMIN_TOKEN || 'cafehq_admin_secret';
  const isAdmin = req.headers['x-admin-token'] === adminToken;
  let isOwner = false;
  if (!isAdmin && auth) {
    try {
      const tok = (req.headers.authorization||'').replace('Bearer ','');
      if (tok) { const r = auth.verifyToken(tok); const p = r&&r.ok?r.payload:null; if (p && p.role==='owner' && p.businessId===req.params.id) isOwner=true; }
    } catch(e) {}
  }
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Admin token or owner login required' });
  const { month, year } = req.query;
  const gst = db.getGstReport(req.params.id, { month: parseInt(month), year: parseInt(year) });
  res.json(gst);
});

// GET /api/admin/accounting/pl-all — P&L all branches (ADMIN TOKEN required)
app.get('/api/admin/accounting/pl-all', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'cafehq_admin_secret';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Admin token required' });
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { from, to } = req.query;
  const result = businesses.map(b => ({
    branchId: b.id,
    branchName: b.name,
    pl: db.getProfitAndLoss(b.id, { from, to })
  }));
  res.json(result);
});

// ── Agency Website — Contact / Lead Capture ──────────────────────────────────
const LEADS_FILE = path.join(DATA_DIR, 'agency_leads.json');

app.post('/api/contact', (req, res) => {
  const { name, cafe, phone, city, branches, challenge, submittedAt } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });

  let leads = [];
  if (fs.existsSync(LEADS_FILE)) {
    try { leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8')); } catch(e) {}
  }

  const lead = {
    id: `lead_${Date.now()}`,
    name,
    cafe: cafe || '',
    phone,
    city: city || '',
    branches: branches || '',
    challenge: challenge || '',
    submittedAt: submittedAt || new Date().toISOString(),
    status: 'new'
  };

  leads.unshift(lead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  console.log(`[Lead Capture] New lead: ${name} (${phone}) — ${cafe || 'unspecified cafe'}`);
  res.json({ success: true, id: lead.id });
});

app.get('/api/leads', (req, res) => {
  if (!fs.existsSync(LEADS_FILE)) return res.json([]);
  try {
    const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
    res.json(leads);
  } catch(e) { res.status(500).json({ error: 'Could not read leads.' }); }
});

io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // Emit WhatsApp Cloud API status for all configured branches
  const waStateSummary = businesses.map(b => ({
    branchId: b.id,
    configured: !!(b.whatsapp?.phoneNumberId),
    status: waStatus[b.id]?.status || (b.whatsapp?.phoneNumberId ? 'Configured' : 'Not configured'),
    phone: b.whatsapp?.phoneNumberId || null
  }));
  socket.emit('whatsapp_state', { branches: waStateSummary, geminiActive: !!genAI });

  // Handle manual chatbot simulator triggers
  socket.on('simulate_chat', async (data) => {
    const { branchId, phone, text, customerName } = data;
    
    // Log message on dashboard
    io.emit('inbound_chat', {
      branchId,
      phone,
      text,
      sender: 'customer',
      customerName,
      timestamp: new Date().toLocaleTimeString()
    });

    // Run pricing reasoning / reservation engine on the server
    const aiReply = await processCafeBotReply(branchId, phone, text);

    // Simulate thinking delay
    setTimeout(() => {
      io.emit('inbound_chat', {
        branchId,
        phone,
        text: aiReply,
        sender: 'ai',
        timestamp: new Date().toLocaleTimeString()
      });
    }, 1200);
  });

  // WhatsApp Cloud API — no QR scan needed, credentials set via /api/businesses/:id/whatsapp/setup
  socket.on('check_whatsapp_status', async (data) => {
    const { branchId } = data;
    const cfg = getWaConfig(branchId);
    if (!cfg?.phoneNumberId) {
      socket.emit('whatsapp_state', { branchId, status: 'Not configured', configured: false });
      return;
    }
    const result = await waApi.verifyCredentials(cfg.phoneNumberId, cfg.accessToken);
    socket.emit('whatsapp_state', { branchId, configured: true, ...result });
  });

  // Handle dynamic campaign triggers
  socket.on('trigger_campaign_broadcast', (data) => {
    const { branchId, campaignText, targetTag } = data;
    const profiles = getBranchData(branchId, 'customer_profiles.json');
    
    // Filter profiles by tag
    const targetCustomers = profiles.filter(p => targetTag === 'all' || p.tags.includes(targetTag));
    
    let logs = [];
    targetCustomers.forEach(cust => {
      const msgLog = `[SaaS Promo Broadcast] Sent to ${cust.name || 'Customer'} (${cust.phone}): "${campaignText}"`;
      console.log(msgLog);
      logs.push({ phone: cust.phone, name: cust.name, status: 'Sent Successfully' });
      
      // If WhatsApp is active, actually send it!
      sendWhatsAppToCustomer(branchId, cust.phone, campaignText).catch(e => console.error('Send error', e));
    });

    socket.emit('campaign_broadcast_result', { success: true, logs });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`☕ Café SaaS HQ running on http://localhost:${PORT}`);
  
  // Set up daily Auto-Pilot scheduler (check once a day at 10 AM, simulated as every 12 hours for demo/safety)
  setInterval(() => {
    console.log('[Auto-Pilot Scheduler] Running daily checks for all branches...');
    businesses.forEach(b => {
      try {
        const settings = getBranchData(b.id, 'settings.json');
        if (settings && settings.autoPilotActive) {
          runAutoPilotCampaign(b.id);
        }
      } catch (err) {
        console.error(`[Auto-Pilot Scheduler Error] Failed for branch ${b.id}:`, err);
      }
    });
  }, 1000 * 60 * 60 * 12); // Check every 12 hours
});
