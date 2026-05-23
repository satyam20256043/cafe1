const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

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

// Directories setup
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Load or Seed Businesses
const BUSINESSES_FILE = path.join(DATA_DIR, 'businesses.json');
let businesses = [];

function loadBusinesses() {
  if (fs.existsSync(BUSINESSES_FILE)) {
    businesses = JSON.parse(fs.readFileSync(BUSINESSES_FILE, 'utf-8'));
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
      { id: '1', name: 'Cold Coffee', category: 'Coffee', price: 149, discount: 0 },
      { id: '2', name: 'Peri Peri Fries', category: 'Fries', price: 119, discount: 10 },
      { id: '3', name: 'Alfredo Pasta', category: 'Pasta', price: 229, discount: 0 },
      { id: '4', name: 'Classic Cheese Burger', category: 'Burgers', price: 179, discount: 20 },
      { id: '5', name: 'Virgin Mojito', category: 'Mocktails', price: 139, discount: 0 }
    ];
    fs.writeFileSync(menuFile, JSON.stringify(defaultMenu, null, 2));
  }

  const reservationsFile = path.join(branchDir, 'reservations.json');
  if (!fs.existsSync(reservationsFile)) {
    const defaultReservations = [
      { id: 'r1', name: 'Rahul Sharma', guests: 4, datetime: 'Friday 7:30 PM', status: 'approved' },
      { id: 'r2', name: 'Priya Patel', guests: 2, datetime: 'Saturday 8:00 PM', status: 'pending' }
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
      lowTrafficCampaigns: [
        { day: 'Tuesday', offer: 'Tuesday Coffee Bonanza - Free Cookie with any Hot Coffee! 🍪☕' },
        { day: 'Wednesday', offer: 'Midweek Pasta Madness - Buy 1 Get 1 50% Off on Alfredo Pasta! 🍝' }
      ]
    };
    fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings, null, 2));
  }
}

loadBusinesses();

// Shared active business for the real WhatsApp Web bot instance
let activeRealBotBusinessId = 'indiranagar';
let whatsappClient = null;
let whatsappQrCodeDataUrl = null;
let whatsappConnectionStatus = 'Disconnected';

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

function updateCustomerProfile(branchId, phone, name, lastIntent) {
  const profiles = getBranchData(branchId, 'customer_profiles.json');
  let profile = profiles.find(p => p.phone === phone);
  if (!profile) {
    profile = { phone, name: name || 'Customer', visits: 0, tags: [] };
    profiles.push(profile);
  }
  profile.visits += 1;
  if (lastIntent && !profile.tags.includes(lastIntent)) {
    profile.tags.push(lastIntent);
  }
  writeBranchData(branchId, 'customer_profiles.json', profiles);
  io.emit('crm_update', { branchId, profiles });
}

// AI response brain
function processCafeBotReply(branchId, fromPhone, incomingMessage) {
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
    userStates[branchId][fromPhone] = { state: 'IDLE', reservationData: { name: null, guests: null, datetime: null } };
  }
  const userState = userStates[branchId][fromPhone];

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

  // 2. ACTIVE RESERVATION FLOW STATE MACHINE
  if (userState.state === 'RESERVATION') {
    const data = userState.reservationData;
    
    // Parse response
    if (!data.name) {
      // Treat the text as name
      data.name = text;
      updateCustomerProfile(branchId, fromPhone, data.name, 'table_booking_flow');
    } else if (!data.guests) {
      // Find guest count
      const numMatch = text.match(/\d+/);
      if (numMatch) {
        data.guests = parseInt(numMatch[0]);
      } else {
        // Fallback translation of simple written numbers
        const words = { 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'panch': 5 };
        const found = Object.keys(words).find(w => lowercaseText.includes(w));
        data.guests = found ? words[found] : 2; // Default to 2 if not parsed
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
        guests: data.guests,
        datetime: data.datetime,
        status: 'pending'
      };
      reservations.push(newRes);
      writeBranchData(branchId, 'reservations.json', reservations);
      
      // Reset user state
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

  // 3. SHORTCUT COMMANDS & INTENTS
  
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
    
    // Construct Menu output
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
  if (['offer', 'offers', 'ऑफर', 'discount', 'sasta', 'coupon', 'deal'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_offers');
    
    let baseOffers = '1. Students get 10% discount with a valid ID card! 🎓\n2. Buy 5 coffees, get 1 free! ☕';
    
    // DYNAMIC LOW-TRAFFIC DAY SPECIAL DETECTION (PROACTIVE)
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

  // GENERAL FRIENDLY CONVERSATIONAL FALLBACK
  if (lang === 'hinglish') {
    return `Hello! 😊 ${business.name} support line par aapka swagat hai. \nAap menu, timing, location, ya table booking ke baare me pooch sakte hain. Main aapki kya help karoon? ☕`;
  } else if (lang === 'hindi') {
    return `नमस्ते! 😊 ${business.name} सहायता लाइन पर आपका स्वागत है। \nआप मेन्यू, समय, स्थान या टेबल बुकिंग के बारे में पूछ सकते हैं। मैं आपकी क्या मदद करूँ? ☕`;
  } else {
    return `Welcome to ${business.name} customer care! 😊\nHow can I assist you today? You can ask about our Menu, Timings, Location, Active Offers, or Book a Table! ☕`;
  }
}

// -------------------------------------------------------------
// Express REST API
// -------------------------------------------------------------

// 1. Get businesses list
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
  res.json(businesses[index]);
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
  res.json({ success: true, menu: menuData });
});

// 6. Get Reservations
app.get('/api/businesses/:id/reservations', (req, res) => {
  res.json(getBranchData(req.params.id, 'reservations.json'));
});

// 7. Update reservation status (approve/cancel)
app.post('/api/businesses/:id/reservations/:resId/status', (req, res) => {
  const { id, resId } = req.params;
  const { status } = req.body;
  const reservations = getBranchData(id, 'reservations.json');
  const index = reservations.findIndex(r => r.id === resId);
  if (index === -1) return res.status(404).json({ error: 'Reservation not found' });

  reservations[index].status = status;
  writeBranchData(id, 'reservations.json', reservations);

  // SIMULATE SENDING WHATSAPP CONGRATULATORY UPDATE
  if (whatsappClient && whatsappConnectionStatus === 'Connected') {
    const notifyMsg = status === 'approved' 
      ? `Hi ${reservations[index].name}! Your table reservation for ${reservations[index].guests} guests on ${reservations[index].datetime} has been officially APPROVED! 🎉 We look forward to seeing you. ☕`
      : `Hi ${reservations[index].name}, due to peak rush or timings, we were unable to approve your booking for ${reservations[index].datetime}. Please try another timing! 😔`;
    
    // In a real scenario, we'd send to reservations[index].phone. For safety during sandbox/playground, we log:
    console.log(`[WhatsApp Broadcast Notification] Sent to customer: "${notifyMsg}"`);
  }

  io.emit('reservation_update', { branchId: id, reservations });
  res.json({ success: true, reservations });
});

// 8. Get CRM profiles
app.get('/api/businesses/:id/crm', (req, res) => {
  res.json(getBranchData(req.params.id, 'customer_profiles.json'));
});

// 9. Get analytics
app.get('/api/businesses/:id/analytics', (req, res) => {
  const traffic = getBranchData(req.params.id, 'traffic_stats.json');
  const profiles = getBranchData(req.params.id, 'customer_profiles.json');
  const reservations = getBranchData(req.params.id, 'reservations.json');
  
  res.json({ traffic, profiles, reservations });
});

// 10. Update campaigns
app.post('/api/businesses/:id/campaigns', (req, res) => {
  const { id } = req.params;
  const { lowTrafficCampaigns } = req.body;
  const settings = getBranchData(id, 'settings.json');
  settings.lowTrafficCampaigns = lowTrafficCampaigns;
  writeBranchData(id, 'settings.json', settings);
  res.json({ success: true, settings });
});

// -------------------------------------------------------------
// REAL WHATSAPP WEB BOT CLIENT INTEGRATION (whatsapp-web.js)
// -------------------------------------------------------------
function initializeWhatsAppClient() {
  if (whatsappClient) return;

  console.log('[WhatsApp System] Starting Web Client...');
  whatsappConnectionStatus = 'Connecting...';
  
  // Clear any stale session lockfile left behind by abrupt Puppeteer crashes to prevent EBUSY errors
  const lockfilePath = path.join(__dirname, '.wwebjs_auth', 'session', 'lockfile');
  if (fs.existsSync(lockfilePath)) {
    try {
      fs.unlinkSync(lockfilePath);
      console.log('[WhatsApp System] Stale session lockfile cleared successfully.');
    } catch (err) {
      console.warn('[WhatsApp System] Stale lockfile warning:', err.message);
    }
  }

  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '.wwebjs_auth')
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  whatsappClient.on('qr', async (qr) => {
    console.log('[WhatsApp System] QR Code Received.');
    whatsappConnectionStatus = 'Ready to Scan';
    try {
      whatsappQrCodeDataUrl = await qrcode.toDataURL(qr);
      io.emit('whatsapp_state', {
        status: whatsappConnectionStatus,
        qr: whatsappQrCodeDataUrl,
        activeBusinessId: activeRealBotBusinessId
      });
    } catch (err) {
      console.error('Error generating QR code', err);
    }
  });

  whatsappClient.on('ready', () => {
    console.log('[WhatsApp System] Connected Successfully!');
    whatsappConnectionStatus = 'Connected';
    whatsappQrCodeDataUrl = null;
    
    // Set active business status to online
    const index = businesses.findIndex(b => b.id === activeRealBotBusinessId);
    if (index !== -1) {
      businesses[index].status = 'online';
      fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
    }

    io.emit('whatsapp_state', {
      status: whatsappConnectionStatus,
      qr: null,
      activeBusinessId: activeRealBotBusinessId,
      number: whatsappClient.info.wid.user
    });
    io.emit('businesses_update', businesses);
  });

  whatsappClient.on('message', async (msg) => {
    // Avoid processing group chats or status updates
    if (msg.from.includes('@g.us')) return;

    const fromPhone = msg.from.split('@')[0];
    const incomingText = msg.body;
    
    console.log(`[WhatsApp Inbound] From ${fromPhone}: "${incomingText}"`);

    // Stream chat message to UI console
    io.emit('inbound_chat', {
      branchId: activeRealBotBusinessId,
      phone: fromPhone,
      text: incomingText,
      sender: 'customer',
      timestamp: new Date().toLocaleTimeString()
    });

    // Run response through AI NLP engine
    const reply = processCafeBotReply(activeRealBotBusinessId, fromPhone, incomingText);

    // Send WhatsApp Outbound reply
    await msg.reply(reply);
    
    console.log(`[WhatsApp Outbound] To ${fromPhone}: "${reply}"`);

    // Stream AI response to UI console
    io.emit('inbound_chat', {
      branchId: activeRealBotBusinessId,
      phone: fromPhone,
      text: reply,
      sender: 'ai',
      timestamp: new Date().toLocaleTimeString()
    });
  });

  whatsappClient.on('disconnected', (reason) => {
    console.log('[WhatsApp System] Client Disconnected: ', reason);
    whatsappConnectionStatus = 'Disconnected';
    whatsappQrCodeDataUrl = null;
    
    // Set active business status to offline
    const index = businesses.findIndex(b => b.id === activeRealBotBusinessId);
    if (index !== -1) {
      businesses[index].status = 'offline';
      fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
    }

    io.emit('whatsapp_state', {
      status: whatsappConnectionStatus,
      qr: null,
      activeBusinessId: activeRealBotBusinessId
    });
    io.emit('businesses_update', businesses);
    
    whatsappClient = null;
  });

  whatsappClient.initialize().catch(err => {
    console.error('[WhatsApp System] Initialization error', err);
    whatsappConnectionStatus = 'Initialization Failed';
    io.emit('whatsapp_state', { status: whatsappConnectionStatus, qr: null });
  });
}

// -------------------------------------------------------------
// Socket.io Real-time Event Handling
// -------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // Emit current WhatsApp linking state immediately on load
  socket.emit('whatsapp_state', {
    status: whatsappConnectionStatus,
    qr: whatsappQrCodeDataUrl,
    activeBusinessId: activeRealBotBusinessId,
    number: whatsappClient && whatsappClient.info ? whatsappClient.info.wid.user : null
  });

  // Handle manual chatbot simulator triggers
  socket.on('simulate_chat', (data) => {
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
    const aiReply = processCafeBotReply(branchId, phone, text);

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

  // Handle WhatsApp client setup triggers
  socket.on('start_whatsapp', (data) => {
    const { branchId } = data;
    activeRealBotBusinessId = branchId;
    initializeWhatsAppClient();
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
      if (whatsappClient && whatsappConnectionStatus === 'Connected') {
        const wid = cust.phone.includes('@') ? cust.phone : `${cust.phone}@c.us`;
        whatsappClient.sendMessage(wid, campaignText).catch(e => console.error('Send error', e));
      }
    });

    socket.emit('campaign_broadcast_result', { success: true, logs });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`☕ Café SaaS HQ running on http://localhost:${PORT}`);
});
