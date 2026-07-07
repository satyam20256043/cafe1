process.env.PORT = 4999; // Choose a random test port
const http = require('http');
const fs = require('fs');
const path = require('path');

console.log("=== Starting Cafe AI Bot System Verification ===");

const DATA_DIR = path.join(__dirname, 'data', 'indiranagar');

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

// Require server to start it
require('./server.js');

// Helper to make HTTP POST requests
function post(path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body || {});
    const req = http.request({
      hostname: 'localhost',
      port: 4999,
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
    http.get(`http://localhost:4999${path}`, (res) => {
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

async function runTests() {
  try {
    resetIndiranagarDatabase();

    // 1. Verify system starts and loads on local server port
    console.log("1. Verifying server responds...");
    const rootRes = await get('/api/businesses');
    if (rootRes.statusCode !== 200 || !Array.isArray(rootRes.body)) {
      throw new Error("Failed to load businesses list on start");
    }
    console.log("   [PASS] Server is listening and responding to /api/businesses");

    // 2. Verify multi-tenant settings are completely isolated per branch
    console.log("2. Verifying multi-tenant isolation...");
    // Let's create a new branch 'jayanagar'
    const createRes = await post('/api/businesses', {
      name: 'Coffee House Jayanagar',
      location: '4th Block, Jayanagar, Bengaluru'
    });
    const jayanagarId = createRes.body.id;
    if (!jayanagarId) {
      throw new Error("Failed to create new business 'jayanagar'");
    }
    console.log(`   [INFO] Created new branch: ${jayanagarId}`);

    // Verify Jayanagar has default menu
    const menuResJ = await get(`/api/businesses/${jayanagarId}/menu`);
    const initialJMenuCount = menuResJ.body.length;
    console.log(`   [INFO] Jayanagar initial menu items: ${initialJMenuCount}`);

    // Modify menu of Jayanagar
    const updatedMenuJ = [
      { id: '1', name: 'Cold Coffee', category: 'Coffee', price: 99, discount: 0 }
    ];
    await post(`/api/businesses/${jayanagarId}/menu`, updatedMenuJ);

    // Verify Jayanagar menu is updated
    const verifyJMenu = await get(`/api/businesses/${jayanagarId}/menu`);
    if (verifyJMenu.body[0].price !== 99) {
      throw new Error("Failed to update Jayanagar menu");
    }

    // Verify Indiranagar menu is unaffected
    const menuResI = await get('/api/businesses/indiranagar/menu');
    const firstItemI = menuResI.body.find(item => item.name === 'Cold Coffee');
    if (firstItemI.price !== 149) {
      throw new Error("Indiranagar menu was affected by Jayanagar update! Multi-tenant isolation failure.");
    }
    console.log("   [PASS] Multi-tenant menu isolation verified.");

    // 3. Verify the AI accurately performs discount and budget reasoning
    console.log("3. Verifying AI NLP pricing and budget reasoning...");
    
    // Test a normal price query
    const chatRes1 = await post('/api/businesses/indiranagar/chat', {
      phone: '9999999999',
      text: 'Cold Coffee kitne ka hai?'
    });
    console.log(`   [CHAT] Q: Cold Coffee kitne ka hai? -> A: ${chatRes1.body.reply}`);
    if (!chatRes1.body.reply.includes('149')) {
      throw new Error("AI did not return the correct standard price (149) for Cold Coffee");
    }

    // Test a discount price query (Peri Peri Fries: price 119, discount 10%)
    const chatRes2 = await post('/api/businesses/indiranagar/chat', {
      phone: '9999999999',
      text: 'Fries kitne ki hai?'
    });
    console.log(`   [CHAT] Q: Fries kitne ki hai? -> A: ${chatRes2.body.reply}`);
    if (!chatRes2.body.reply.includes('119') || !chatRes2.body.reply.includes('107') || !chatRes2.body.reply.includes('10%')) {
      throw new Error("AI did not correctly perform discount reasoning for Peri Peri Fries");
    }

    // Test budget reasoning: "sasta kya hai"
    const chatRes3 = await post('/api/businesses/indiranagar/chat', {
      phone: '9999999999',
      text: 'Sabse sasta kya hai?'
    });
    console.log(`   [CHAT] Q: Sabse sasta kya hai? -> A: ${chatRes3.body.reply}`);
    // Bestseller fries is 107, Cold Coffee is 149.
    // In indiranagar default menu:
    // - Cold Coffee: 149
    // - Peri Peri Fries: 119 - 10% = 107
    // - Virgin Mojito: 139
    // - Classic Cheese Burger: 179 - 20% = 143
    // - Alfredo Pasta: 229
    // Top 2 cheapest are Peri Peri Fries and Virgin Mojito.
    if (!chatRes3.body.reply.toLowerCase().includes('fries') || !chatRes3.body.reply.toLowerCase().includes('mojito')) {
      throw new Error("AI budget search reasoning failed to identify cheapest items (Peri Peri Fries & Virgin Mojito)");
    }
    console.log("   [PASS] AI pricing and budget reasoning verified.");

    // 4. Verify reservation ledgers update dynamically and persist in JSON
    console.log("4. Verifying reservation flow and database persistence...");
    
    // Start reservation flow
    const step1 = await post('/api/businesses/indiranagar/chat', {
      phone: '8888888888',
      text: 'bhai table book karna hai'
    });
    console.log(`   [FLOW] Q: bhai table book karna hai -> A: ${step1.body.reply}`);
    if (!step1.body.reply.toLowerCase().includes('naam') && !step1.body.reply.toLowerCase().includes('name')) {
      throw new Error("Reservation flow did not prompt for name");
    }

    // Provide name
    const step2 = await post('/api/businesses/indiranagar/chat', {
      phone: '8888888888',
      text: 'Amit Kumar'
    });
    console.log(`   [FLOW] Q: Amit Kumar -> A: ${step2.body.reply}`);
    if (!step2.body.reply.toLowerCase().includes('guest') && !step2.body.reply.toLowerCase().includes('log')) {
      throw new Error("Reservation flow did not prompt for guest count");
    }

    // Provide guests
    const step3 = await post('/api/businesses/indiranagar/chat', {
      phone: '8888888888',
      text: '4'
    });
    console.log(`   [FLOW] Q: 4 -> A: ${step3.body.reply}`);
    if (!step3.body.reply.toLowerCase().includes('time') && !step3.body.reply.toLowerCase().includes('samay') && !step3.body.reply.toLowerCase().includes('date')) {
      throw new Error("Reservation flow did not prompt for date & time");
    }

    // Provide datetime and complete booking
    const step4 = await post('/api/businesses/indiranagar/chat', {
      phone: '8888888888',
      text: 'Tonight at 8 PM'
    });
    console.log(`   [FLOW] Q: Tonight at 8 PM -> A: ${step4.body.reply}`);
    if (!step4.body.reply.toLowerCase().includes('successfully')) {
      throw new Error("Reservation completion message check failed");
    }

    // Verify reservation was written to reservations.json
    const resRes = await get('/api/businesses/indiranagar/reservations');
    const newBooking = resRes.body.find(r => r.name === 'Amit Kumar');
    if (!newBooking || newBooking.guests !== 4 || newBooking.datetime !== 'Tonight at 8 PM') {
      throw new Error("Reservation was not persisted correctly in JSON ledger!");
    }
    console.log("   [PASS] Reservation flow and persistence verified.");

    // 5. Verify AI Conversational fallbacks
    console.log("5. Verifying AI general conversational response...");
    const chatConv1 = await post('/api/businesses/indiranagar/chat', {
      phone: '7777777777',
      text: 'hello'
    });
    console.log(`   [CONV] Q: hello -> A: ${chatConv1.body.reply}`);
    if (!chatConv1.body.reply.toLowerCase().includes('hello') && !chatConv1.body.reply.toLowerCase().includes('swagat') && !chatConv1.body.reply.toLowerCase().includes('welcome')) {
      throw new Error("AI Conversational hello response failed");
    }

    const chatConv2 = await post('/api/businesses/indiranagar/chat', {
      phone: '7777777777',
      text: 'recommend some tasty food'
    });
    console.log(`   [CONV] Q: recommend some tasty food -> A: ${chatConv2.body.reply}`);
    if (!chatConv2.body.reply.toLowerCase().includes('coffee') && !chatConv2.body.reply.toLowerCase().includes('fries')) {
      throw new Error("AI Conversational food recommendation response failed");
    }
    console.log("   [PASS] Conversational AI general query responses verified.");

    // 6. Verify custom offer requests and manager approvals
    console.log("6. Verifying Custom Offer Request and approval flow...");
    const offerChat = await post('/api/businesses/indiranagar/chat', {
      phone: '6666666666',
      text: 'bhai party ke liye group discount kardo please'
    });
    console.log(`   [OFFER] Q: group discount kardo -> A: ${offerChat.body.reply}`);
    if (!offerChat.body.reply.toLowerCase().includes('manager') && !offerChat.body.reply.toLowerCase().includes('approval')) {
      throw new Error("AI did not correctly flag custom discount request for manager review");
    }

    // Verify request is saved
    const offersList = await get('/api/businesses/indiranagar/offers');
    const myRequest = [...offersList.body].reverse().find(o => o.phone === '6666666666');
    if (!myRequest || myRequest.status !== 'pending') {
      throw new Error("Custom offer request not saved in pending state!");
    }
    const offerId = myRequest.id;

    // Approve the offer
    const approveRes = await post(`/api/businesses/indiranagar/offers/${offerId}/approve`, {
      customText: 'Special Flat 20% Off Code: PARTY20 approved by Manager! 🎉'
    });
    const updatedRequest = approveRes.body.offers.find(o => o.id === offerId);
    if (!updatedRequest || updatedRequest.status !== 'approved' || updatedRequest.approvedOffer !== 'Special Flat 20% Off Code: PARTY20 approved by Manager! 🎉') {
      throw new Error("Manager offer approval API failed to persist status!");
    }
    console.log("   [PASS] Custom Offer Request and manager approval workflow verified.");

    // 7. Verify WhatsApp Feedback flow and database persistence
    console.log("7. Verifying WhatsApp Feedback flow step-by-step...");
    
    // Step 1: Send feedback request
    const fbStep1 = await post('/api/businesses/indiranagar/chat', {
      phone: '5555555555',
      text: 'I want to give feedback'
    });
    console.log(`   [FEEDBACK] Q: I want to give feedback -> A: ${fbStep1.body.reply}`);
    if (!fbStep1.body.reply.toLowerCase().includes('rate') && !fbStep1.body.reply.toLowerCase().includes('stars')) {
      throw new Error("Feedback flow did not prompt for 1-5 stars rating");
    }

    // Step 2: Send rating
    const fbStep2 = await post('/api/businesses/indiranagar/chat', {
      phone: '5555555555',
      text: '5'
    });
    console.log(`   [FEEDBACK] Q: 5 -> A: ${fbStep2.body.reply}`);
    if (!fbStep2.body.reply.toLowerCase().includes('comment') && !fbStep2.body.reply.toLowerCase().includes('suggestion')) {
      throw new Error("Feedback flow did not prompt for comment/suggestion");
    }

    // Step 3: Send comment
    const fbStep3 = await post('/api/businesses/indiranagar/chat', {
      phone: '5555555555',
      text: 'Delicious cold coffee!'
    });
    console.log(`   [FEEDBACK] Q: Delicious cold coffee! -> A: ${fbStep3.body.reply}`);
    if (!fbStep3.body.reply.toLowerCase().includes('thank') && !fbStep3.body.reply.toLowerCase().includes('shukriya')) {
      throw new Error("Feedback flow did not reply with thank you message");
    }

    // Step 4: Verify feedback was written to feedback.json
    const fbRes = await get('/api/businesses/indiranagar/feedback');
    const newFeedback = fbRes.body.find(f => f.comment === 'Delicious cold coffee!');
    if (!newFeedback || newFeedback.rating !== 5) {
      throw new Error("Feedback was not saved correctly in feedback.json ledger!");
    }

    // Step 5: Verify customer CRM records updated
    const crmRes = await get('/api/businesses/indiranagar/crm');
    const custProfile = crmRes.body.find(p => p.phone === '5555555555');
    if (!custProfile || custProfile.averageRating !== 5 || !custProfile.tags.includes('gave_feedback')) {
      throw new Error("Customer profile was not updated correctly in CRM database!");
    }
    console.log("   [PASS] Feedback flow, ledger persistence, and CRM updates verified.");

    // 8. Verify Auto-Pilot Low-Traffic Campaign Engine
    console.log("8. Verifying Auto-Pilot Low-Traffic Campaign Engine...");
    
    // Step 1: Force trigger Tuesday campaign
    const triggerRes = await post('/api/businesses/indiranagar/autopilot/trigger', {
      forceDay: 'Tuesday'
    });
    console.log(`   [AUTOPILOT] Tuesday Campaign Triggered. Target Count: ${triggerRes.body.result.count}`);
    if (!triggerRes.body.success || triggerRes.body.result.count === 0) {
      throw new Error("Auto-Pilot failed to target eligible customers for Tuesday campaign!");
    }

    // Step 2: Verify offer is logged inside customer profiles
    const crmAfterCampaign = await get('/api/businesses/indiranagar/crm');
    const targetedCust = crmAfterCampaign.body.find(p => p.phone === '9876543210'); // Rahul Sharma
    if (!targetedCust || !targetedCust.offersReceived || targetedCust.offersReceived.length === 0) {
      throw new Error("Auto-Pilot campaign offer was not logged in target customer profile!");
    }
    console.log(`   [AUTOPILOT] Offer logged in Rahul's CRM profile: "${targetedCust.offersReceived[0].offer}"`);

    // Step 3: Run again immediately and verify no-op (48h rate limiting)
    const triggerRes2 = await post('/api/businesses/indiranagar/autopilot/trigger', {
      forceDay: 'Tuesday'
    });
    console.log(`   [AUTOPILOT] Running Tuesday campaign again. Target Count: ${triggerRes2.body.result.count}`);
    if (triggerRes2.body.result.count !== 0) {
      throw new Error("Auto-Pilot failed to enforce 48h safety spam limit!");
    }
    console.log("   [PASS] Auto-Pilot Campaign Engine and 48h rate-limiting verified.");

    // 9. Verify Google Business Profile link and unlink APIs
    console.log("9. Verifying Google Business Profile link and unlink APIs...");
    const linkRes = await post('/api/businesses/indiranagar/gbp/link', { locationId: 'loc_bean_indira' });
    if (!linkRes.body.success || !linkRes.body.settings.gbpLinked || linkRes.body.settings.gbpLocationId !== 'loc_bean_indira') {
      throw new Error("Failed to link Google Business Profile");
    }
    const unlinkRes = await post('/api/businesses/indiranagar/gbp/link', { locationId: null });
    if (unlinkRes.body.settings.gbpLinked || unlinkRes.body.settings.gbpLocationId !== '') {
      throw new Error("Failed to unlink Google Business Profile");
    }
    // Re-link for the sync test
    await post('/api/businesses/indiranagar/gbp/link', { locationId: 'loc_bean_indira' });
    console.log("   [PASS] Google Business Profile link/unlink APIs verified.");

    // 10. Verify Google Business Profile reviews synchronization API
    console.log("10. Verifying Google Business Profile reviews sync API...");
    const syncRes = await post('/api/businesses/indiranagar/gbp/sync');
    if (!syncRes.body.success || syncRes.body.addedCount !== 3) {
      throw new Error(`Failed to sync Google Business Profile reviews. Added count: ${syncRes.body.addedCount}`);
    }
    // Verify duplicate sync is no-op
    const syncRes2 = await post('/api/businesses/indiranagar/gbp/sync');
    if (syncRes2.body.addedCount !== 0) {
      throw new Error("Google Business Profile reviews sync did not prevent duplicate reviews sync.");
    }
    console.log("   [PASS] Google Business Profile reviews sync verified.");

    // 11. Verify Customer Website Serve and submissions
    console.log("11. Verifying Customer Website endpoints...");
    const pageRes = await get('/cafe/indiranagar');
    if (pageRes.statusCode !== 200 || !pageRes.body.includes('<!DOCTYPE html>')) {
      throw new Error("Failed to serve customer website page /cafe/indiranagar");
    }
    
    // Test reservation submission
    const webResBooking = await post('/api/businesses/indiranagar/reservations', {
      name: 'Rohan Web Booking',
      phone: '9998887777',
      guests: 3,
      datetime: 'Sunday at 1:00 PM'
    });
    if (!webResBooking.body.success || webResBooking.body.reservation.name !== 'Rohan Web Booking') {
      throw new Error("Failed to submit table reservation via Customer Website API");
    }
    
    // Test feedback submission
    const webResFeedback = await post('/api/businesses/indiranagar/feedback', {
      customerName: 'Sneha Web Feedback',
      phone: '8887776666',
      rating: 5,
      comment: 'Delicious burger from website!'
    });
    if (!webResFeedback.body.success || webResFeedback.body.feedback.customerName !== 'Sneha Web Feedback') {
      throw new Error("Failed to submit customer feedback via Customer Website API");
    }
    console.log("   [PASS] Customer Website serve, reservation and feedback APIs verified.");

    // 12. Verify Independent Franchise Manager Panel
    console.log("12. Verifying Independent Franchise Manager Panel...");
    const mgrPageRes = await get('/manager/indiranagar');
    if (mgrPageRes.statusCode !== 200 || !mgrPageRes.body.includes('Franchise Manager Console')) {
      throw new Error("Failed to serve branch manager portal page /manager/indiranagar");
    }
    console.log("   [PASS] Independent Franchise Manager Panel verified.");

    console.log("\n⭐️ ALL SYSTEM VERIFICATIONS PASSED SUCCESSFULLY! ⭐️");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ SYSTEM VERIFICATION FAILED:", error);
    process.exit(1);
  }
}

// Wait for server to bind
setTimeout(runTests, 1000);
