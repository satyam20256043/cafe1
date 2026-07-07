process.env.PORT = 4999;
require('./server.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

console.log("=== Starting Cafe SaaS Feature-Specific Verification ===");

const PORT = 4999;
const DATA_DIR = path.join(__dirname, 'data', 'indiranagar');

// Helper to make HTTP POST requests
function post(path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body || {});
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Helper to make HTTP GET requests
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

function resetIndiranagarDatabase() {
  console.log("   [CLEANUP] Resetting Indiranagar test database files...");
  
  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
  }

  const defaultMenu = [
    { id: '1', name: 'Cold Coffee', category: 'Coffee', price: 149, discount: 0, description: 'Signature rich cold coffee blended with vanilla ice cream and topped with cocoa powder.' },
    { id: '2', name: 'Peri Peri Fries', category: 'Fries', price: 119, discount: 10, description: 'Crispy golden fries tossed in our signature spicy peri peri seasoning.' },
    { id: '3', name: 'Alfredo Pasta', category: 'Pasta', price: 229, discount: 0, description: 'Rich and creamy penne pasta tossed in garlic parmesan white sauce with mushrooms.' },
    { id: '4', name: 'Classic Cheese Burger', category: 'Burgers', price: 179, discount: 20, description: "Juicy flame-grilled burger patty topped with cheddar cheese, lettuce, tomatoes, and chef's special burger sauce." },
    { id: '5', name: 'Virgin Mojito', category: 'Mocktails', price: 139, discount: 0, description: 'Refreshing summer cooler made with fresh mint leaves, lime wedges, simple syrup, and sparkling soda.' },
    { id: '6', name: 'Coffee & Burger Combo', category: 'Combo', price: 299, discount: 15, description: 'Classic Cheese Burger paired with our signature Cold Coffee. The ultimate pick-me-up meal.' },
    { id: '7', name: 'Pasta & Mojito Combo', category: 'Combo', price: 349, discount: 10, description: 'Alfredo Pasta served with a refreshing glass of Virgin Mojito. Complete delicious lunch combo.' }
  ];
  fs.writeFileSync(path.join(DATA_DIR, 'menu.json'), JSON.stringify(defaultMenu, null, 2));

  const defaultReservations = [
    { id: 'r1', name: 'Rahul Sharma', guests: 4, datetime: 'Friday 7:30 PM', status: 'approved' },
    { id: 'r2', name: 'Priya Patel', guests: 2, datetime: 'Saturday 8:00 PM', status: 'pending' }
  ];
  fs.writeFileSync(path.join(DATA_DIR, 'reservations.json'), JSON.stringify(defaultReservations, null, 2));

  const defaultProfiles = [
    { phone: '9876543210', name: 'Rahul Sharma', visits: 3, tags: ['interested_in_coffee', 'frequent_booker'] },
    { phone: '8765432109', name: 'Priya Patel', visits: 1, tags: ['asked_for_offers', 'interested_in_burgers'] }
  ];
  fs.writeFileSync(path.join(DATA_DIR, 'customer_profiles.json'), JSON.stringify(defaultProfiles, null, 2));

  const defaultSettings = {
    autoPilotActive: true,
    lowTrafficCampaigns: [
      { day: 'Tuesday', offer: 'Tuesday Coffee Bonanza - Free Cookie with any Hot Coffee! 🍪☕' },
      { day: 'Wednesday', offer: 'Midweek Pasta Madness - Buy 1 Get 1 50% Off on Alfredo Pasta! 🍝' }
    ]
  };
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(defaultSettings, null, 2));

  fs.writeFileSync(path.join(DATA_DIR, 'offer_requests.json'), JSON.stringify([], null, 2));

  const defaultFeedback = [
    { id: 'f1', customerName: 'Rohan Mehta', rating: 5, comment: 'Bhai, cold coffee ekdum lajawab thi! Aur staff bhi bohot friendly hai. Will visit again! ☕😊', timestamp: 'Friday 9:00 PM' },
    { id: 'f2', customerName: 'Sneha Sen', rating: 3, comment: 'Alfredo Pasta was a bit dry, but the burger and mojito were great! Nice vibe.', timestamp: 'Saturday 7:30 PM' }
  ];
  fs.writeFileSync(path.join(DATA_DIR, 'feedback.json'), JSON.stringify(defaultFeedback, null, 2));
}

async function runTests() {
  try {
    resetIndiranagarDatabase();
    // 1. Verify CRM Loyalty Tiers calculation and mappings
    console.log("1. Verifying loyalty tier calculations...");
    const phone = '9900990099';
    const name = 'Loyalty Test Customer';
    
    // Visit 1: Submit table reservation (creates profile, sets visits to 1, tier: New Customer)
    await post('/api/businesses/indiranagar/reservations', {
      name,
      phone,
      guests: 2,
      datetime: 'Tonight at 8 PM'
    });
    
    let crm = await get('/api/businesses/indiranagar/crm');
    let profile = crm.body.find(p => p.phone === phone);
    console.log(`   [INFO] Visit 1 visits: ${profile.visits}, tier: ${profile.loyaltyTier}`);
    if (profile.loyaltyTier !== 'New Customer' || profile.visits !== 1) {
      throw new Error("Tier should be 'New Customer' for 1 visit");
    }

    // Visit 2: Chat Menu query (increments visits to 2, tier: Regular)
    await post('/api/businesses/indiranagar/chat', { phone, text: 'show me menu' });
    crm = await get('/api/businesses/indiranagar/crm');
    profile = crm.body.find(p => p.phone === phone);
    console.log(`   [INFO] Visit 2 visits: ${profile.visits}, tier: ${profile.loyaltyTier}`);
    if (profile.loyaltyTier !== 'Regular' || profile.visits !== 2) {
      throw new Error("Tier should be 'Regular' for 2 visits");
    }

    // Fast-track visits: simulation (inquiring menu to trigger visits)
    // Let's simulate up to 5 visits: VIP
    for (let i = 3; i <= 5; i++) {
      await post('/api/businesses/indiranagar/chat', { phone, text: 'show me menu' });
    }
    crm = await get('/api/businesses/indiranagar/crm');
    profile = crm.body.find(p => p.phone === phone);
    console.log(`   [INFO] Visit 5 visits: ${profile.visits}, tier: ${profile.loyaltyTier}`);
    if (profile.loyaltyTier !== 'VIP' || profile.visits !== 5) {
      throw new Error("Tier should be 'VIP' for 5 visits");
    }

    // Let's simulate up to 10 visits: Elite
    for (let i = 6; i <= 10; i++) {
      await post('/api/businesses/indiranagar/chat', { phone, text: 'show me menu' });
    }
    crm = await get('/api/businesses/indiranagar/crm');
    profile = crm.body.find(p => p.phone === phone);
    console.log(`   [INFO] Visit 10 visits: ${profile.visits}, tier: ${profile.loyaltyTier}`);
    if (profile.loyaltyTier !== 'Elite' || profile.visits !== 10) {
      throw new Error("Tier should be 'Elite' for 10 visits");
    }
    console.log("   [PASS] Loyalty Tier progression successfully verified.");

    // 2. Verify AI-Powered Feedback responses
    console.log("2. Verifying AI-powered feedback response endpoints...");
    
    // Generate draft response
    const draftRes = await post('/api/businesses/indiranagar/feedback/f1/reply-draft');
    console.log(`   [INFO] Generated draft for Rohan (f1): "${draftRes.body.draft}"`);
    if (!draftRes.body.success || !draftRes.body.draft) {
      throw new Error("Failed to generate draft reply for f1");
    }

    // Submit response reply
    const replyText = "Thank you Rohan! Glad you loved the cold coffee.";
    const submitRes = await post('/api/businesses/indiranagar/feedback/f1/reply', { reply: replyText });
    if (!submitRes.body.success || submitRes.body.feedback.managerReply !== replyText) {
      throw new Error("Failed to save manager response reply");
    }
    
    // Verify persistence
    const fbList = await get('/api/businesses/indiranagar/feedback');
    const rohanFb = fbList.body.find(f => f.id === 'f1');
    if (rohanFb.managerReply !== replyText) {
      throw new Error("Feedback reply not persisted in database");
    }
    console.log("   [PASS] AI-Powered feedback responses draft and save flow verified.");

    // 3. Verify Gamified Reviews (5-star rewards)
    console.log("3. Verifying review gamification (5-star rewards)...");
    
    // Web feedback 5-star submission
    const webFbRes = await post('/api/businesses/indiranagar/feedback', {
      customerName: 'Gamified Reviewer',
      phone: '8877665544',
      rating: 5,
      comment: 'Absolutely spectacular vibes and coffee!'
    });
    console.log(`   [INFO] Web feedback submit response couponCode: ${webFbRes.body.feedback.couponCode}`);
    if (webFbRes.body.feedback.couponCode !== 'THANKYOU15') {
      throw new Error("Failed to assign THANKYOU15 coupon code to 5-star web review");
    }

    // Verify it was logged in the customer profile
    crm = await get('/api/businesses/indiranagar/crm');
    profile = crm.body.find(p => p.phone === '8877665544');
    if (!profile || !profile.offersReceived.some(o => o.offer.includes('THANKYOU15'))) {
      throw new Error("Coupon was not saved under CRM customer offersReceived");
    }

    // Chatbot feedback 5-star submission
    const cbStep1 = await post('/api/businesses/indiranagar/chat', { phone: '7766554433', text: 'I want to leave a review', customerName: 'Chatbot reviewer' });
    const cbStep2 = await post('/api/businesses/indiranagar/chat', { phone: '7766554433', text: '5' });
    const cbStep3 = await post('/api/businesses/indiranagar/chat', { phone: '7766554433', text: 'Awesome experience!' });
    console.log(`   [CHATBOT FEEDBACK REPLY]: ${cbStep3.body.reply}`);
    if (!cbStep3.body.reply.includes('THANKYOU15')) {
      throw new Error("Chatbot feedback flow did not return THANKYOU15 coupon code for 5-star review");
    }

    // Sync GBP matches
    console.log("4. Verifying GBP review sync matches with CRM profiles...");
    // Let's create a CRM profile named 'Aditya Sen' (matches synced review name)
    const seedPhone = '9000100020';
    await post('/api/businesses/indiranagar/chat', { phone: seedPhone, text: 'hello', customerName: 'Aditya Sen' });
    
    // Perform sync
    await post('/api/businesses/indiranagar/gbp/link', { locationId: 'roasted-bean-indira' });
    const syncRes = await post('/api/businesses/indiranagar/gbp/sync');
    console.log(`   [SYNC INFO] Sync completed. Added count: ${syncRes.body.addedCount}`);
    
    // Verify Aditya Sen profile got the REVIEW15 coupon reward
    crm = await get('/api/businesses/indiranagar/crm');
    const adityaProfile = crm.body.find(p => p.phone === seedPhone);
    console.log(`   [CRM INFO] Aditya Sen offersReceived:`, adityaProfile.offersReceived);
    if (!adityaProfile || !adityaProfile.offersReceived.some(o => o.offer.includes('REVIEW15'))) {
      throw new Error("Aditya Sen profile did not get the REVIEW15 reward coupon on sync match");
    }
    // 5. Verify AI campaign suggestion engine and approval route
    console.log("5. Verifying AI campaign suggestion engine and approvals...");
    const suggestionsRes = await get('/api/businesses/indiranagar/ai-campaign-suggestions');
    if (!Array.isArray(suggestionsRes.body) || suggestionsRes.body.length === 0) {
      throw new Error("Failed to generate AI campaign suggestions");
    }
    console.log(`   [AI INFO] Generated suggestions count: ${suggestionsRes.body.length}`);
    const targetSug = suggestionsRes.body.find(s => s.customerPhone === seedPhone); // Aditya Sen
    if (!targetSug) {
      throw new Error("Aditya Sen was not found in AI suggestions list");
    }
    console.log(`   [AI INFO] Aditya Sen suggestion draft: "${targetSug.offerText}"`);
    
    // Approve suggestion
    const customCampaignText = "Special VIP deal for you Aditya! Enjoy 15% off!";
    const approveSugRes = await post(`/api/businesses/indiranagar/ai-campaign-suggestions/${targetSug.id}/approve`, {
      customOfferText: customCampaignText
    });
    if (!approveSugRes.body.success || approveSugRes.body.suggestion.status !== 'approved') {
      throw new Error("Failed to approve and send campaign suggestion");
    }
    
    // Verify it was logged in Aditya Sen CRM offers
    crm = await get('/api/businesses/indiranagar/crm');
    const adityaProfileUpdated = crm.body.find(p => p.phone === seedPhone);
    console.log("   [CRM INFO] Aditya Sen updated offersReceived:", adityaProfileUpdated.offersReceived);
    if (!adityaProfileUpdated.offersReceived.some(o => o.offer.includes(customCampaignText))) {
      throw new Error("Approved campaign offer was not saved to Aditya Sen CRM offersReceived list");
    }
    console.log("   [PASS] AI Campaign Suggestion Engine and approval workflow verified.");

    console.log("\n⭐️ ALL NEW FEATURES VERIFIED SUCCESSFULLY! ⭐️");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ FEATURE VERIFICATION FAILED:", error);
    process.exit(1);
  }
}

// Wait 1 second before starting tests
setTimeout(runTests, 1000);
