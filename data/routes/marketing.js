'use strict';
// Auto-extracted from server.js — do not edit manually.
module.exports = function register(ctx) {
  const {
    app, io, fs, path,
    DATA_DIR, BUSINESSES_FILE, businesses,
    getBranchData, writeBranchData,
    updateCustomerProfile, processCafeBotReply,
    waApi, genAI, razorpay, whatsappConnectionStatus,
    requireAuth, requireBranchAccess, requireRole,
    signToken, verifyToken, loadStaff, STAFF_FILE,
    getSubscriptionStatus, requireActiveSubscription,
    db,
    whatsappClient,
    emitToBranch,
  } = ctx;

// ── Chat message log ─────────────────────────────────────────────────────────
try {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL, phone TEXT NOT NULL,
    customer_name TEXT, direction TEXT NOT NULL,
    message TEXT NOT NULL, channel TEXT DEFAULT 'whatsapp',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ); CREATE INDEX IF NOT EXISTS idx_chat_biz ON chat_messages(business_id,phone,created_at)`);
} catch(e) {}
function saveMsg(b,p,n,d,m,c){
  try{db.prepare('INSERT INTO chat_messages(business_id,phone,customer_name,direction,message,channel)VALUES(?,?,?,?,?,?)').run(b,p||'',n||null,d,m||'',c||'whatsapp');}catch(e){}
}

// ════════════════════════════════════════════════════════════════════════════
// Google Review Verification Routes
// ════════════════════════════════════════════════════════════════════════════

// GET /api/businesses/:id/google-review/claims
app.get('/api/businesses/:id/google-review/claims', requireAuth, requireBranchAccess, (req, res) => {
  const claims = getBranchData(req.params.id, 'google_review_claims.json') || [];
  res.json(claims);
});

// POST /api/businesses/:id/google-review/:claimId/approve
app.post('/api/businesses/:id/google-review/:claimId/approve', requireAuth, requireBranchAccess, async (req, res) => {
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
      emitToBranch(id, 'loyalty_update', { businessId: id, card });
    } catch(e) { return res.status(500).json({ error: 'Points award failed: ' + e.message }); }
  }

  // Update claim status
  claims[idx].status = 'approved';
  claims[idx].approvedAt = new Date().toISOString();
  writeBranchData(id, 'google_review_claims.json', claims);
  emitToBranch(id, 'google_review_claim_update', { branchId: id, claim: claims[idx] });

  // Notify customer via WhatsApp
  if (whatsappClient) {
    try {
      const business = businesses.find(b => b.id === id) || { name: 'Zordic California' };
      const chatId = '91' + claim.phone + '@c.us';
      const newBal = card ? card.points : '?';
      await whatsappClient.sendMessage(chatId,
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
app.post('/api/businesses/:id/google-review/:claimId/reject', requireAuth, requireBranchAccess, async (req, res) => {
  const { id, claimId } = req.params;
  const { reason } = req.body;
  const claims = getBranchData(id, 'google_review_claims.json') || [];
  const idx = claims.findIndex(c => c.id === claimId);
  if (idx === -1) return res.status(404).json({ error: 'Claim not found' });

  claims[idx].status = 'rejected';
  claims[idx].rejectedAt = new Date().toISOString();
  claims[idx].rejectReason = reason || 'Review not found';
  writeBranchData(id, 'google_review_claims.json', claims);
  emitToBranch(id, 'google_review_claim_update', { branchId: id, claim: claims[idx] });

  // Notify customer
  if (whatsappClient) {
    try {
      const chatId = '91' + claims[idx].phone + '@c.us';
      const business = businesses.find(b => b.id === id) || { name: 'Zordic California', review: '' };
      await whatsappClient.sendMessage(chatId,
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
app.post('/api/businesses/:id/menu', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const menuData = req.body; // Expect array of items
  writeBranchData(id, 'menu.json', menuData);
  res.json({ success: true, menu: menuData });
});

// 6. Get Reservations — staff only (the ledger contains customer names + phones)
app.get('/api/businesses/:id/reservations', requireAuth, requireBranchAccess, (req, res) => {
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
  
  emitToBranch(id, 'reservation_update', { branchId: id, reservations });
  res.json({ success: true, reservation: newRes });
});

// 7. Update reservation status (approve/cancel)
app.post('/api/businesses/:id/reservations/:resId/status', requireAuth, requireBranchAccess, (req, res) => {
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

  emitToBranch(id, 'reservation_update', { branchId: id, reservations });
  res.json({ success: true, reservations });
});

// 8. Get CRM profiles
app.get('/api/businesses/:id/crm', requireAuth, requireBranchAccess, (req, res) => {
  res.json(getBranchData(req.params.id, 'customer_profiles.json'));
});

// 9. Get analytics
app.get('/api/businesses/:id/analytics', requireAuth, requireBranchAccess, (req, res) => {
  const traffic = getBranchData(req.params.id, 'traffic_stats.json');
  const profiles = getBranchData(req.params.id, 'customer_profiles.json');
  const reservations = getBranchData(req.params.id, 'reservations.json');
  const settings = getBranchData(req.params.id, 'settings.json');
  
  res.json({ traffic, profiles, reservations, settings });
});

// 10. Update campaigns
app.post('/api/businesses/:id/campaigns', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const { lowTrafficCampaigns } = req.body;
  const settings = getBranchData(id, 'settings.json');
  settings.lowTrafficCampaigns = lowTrafficCampaigns;
  writeBranchData(id, 'settings.json', settings);
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
        emitToBranch(id, 'crm_update', { branchId: id, profiles });
      }
    }
  }
  
  emitToBranch(id, 'feedback_update', { branchId: id, feedback });
  res.json({ success: true, feedback: newFb });
});

function getDefaultDraftReply(customerName, rating) {
  if (rating >= 4) {
    return `Thank you so much for the wonderful review, ${customerName}! We're thrilled you enjoyed your visit and look forward to welcoming you back soon! 😊☕`;
  } else {
    return `Hello ${customerName}, we are truly sorry to hear that your experience wasn't up to our usual standards. We value your feedback and would love to make this right on your next visit. Please contact us directly.`;
  }
}

// Generate draft AI reply for feedback — staff only (each call spends Gemini quota)
app.post('/api/businesses/:id/feedback/:feedbackId/reply-draft', requireAuth, requireBranchAccess, async (req, res) => {
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
app.post('/api/businesses/:id/feedback/:feedbackId/reply', requireAuth, requireBranchAccess, (req, res) => {
  const { id, feedbackId } = req.params;
  const { reply } = req.body;
  const feedback = getBranchData(id, 'feedback.json');
  const index = feedback.findIndex(f => f.id === feedbackId);
  if (index === -1) return res.status(404).json({ error: 'Feedback not found' });
  
  feedback[index].managerReply = reply;
  feedback[index].replyTimestamp = new Date().toLocaleString();
  writeBranchData(id, 'feedback.json', feedback);
  
  emitToBranch(id, 'feedback_update', { branchId: id, feedback });
  res.json({ success: true, feedback: feedback[index] });
});

// 10b. Toggle Auto-Pilot setting
app.post('/api/businesses/:id/autopilot/toggle', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  const settings = getBranchData(id, 'settings.json');
  settings.autoPilotActive = !!active;
  writeBranchData(id, 'settings.json', settings);
  res.json({ success: true, settings });
});

// 10c. Manual trigger Auto-Pilot campaign
app.post('/api/businesses/:id/autopilot/trigger', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const { forceDay } = req.body;
  // runAutoPilotCampaign lives in server.js and is shared via ctx (was a ReferenceError here)
  const result = ctx.runAutoPilotCampaign(id, forceDay);
  res.json({ success: true, result });
});

// 10d. Link Google Business Profile
app.post('/api/businesses/:id/gbp/link', requireAuth, requireBranchAccess, (req, res) => {
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
app.post('/api/businesses/:id/gbp/sync', requireAuth, requireBranchAccess, (req, res) => {
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
            emitToBranch(id, 'inbound_chat', {
              branchId: id,
              phone: matchingProfile.phone,
              text: `🎁 *[GOOGLE REVIEW REWARD]*: Hi ${matchingProfile.name}! Thank you for your 5-star review on Google! Here is your reward coupon: *${couponCode}* for 15% off on your next visit! ☕✨`,
              sender: 'ai',
              timestamp: new Date().toLocaleTimeString()
            });
            
            // If WhatsApp client is connected, actually send it
            if (whatsappClient && whatsappConnectionStatus === 'Connected') {
              const wid = matchingProfile.phone.includes('@') ? matchingProfile.phone : `${matchingProfile.phone}@c.us`;
              whatsappClient.sendMessage(wid, `Hi ${matchingProfile.name}! Thank you for your 5-star review on Google! Here is your reward coupon: *${couponCode}* for 15% off on your next visit! ☕✨`).catch(e => console.error(e));
            }
          }
        }
      }
    });
    writeBranchData(id, 'customer_profiles.json', profiles);
    emitToBranch(id, 'crm_update', { branchId: id, profiles });
    emitToBranch(id, 'feedback_update', { branchId: id, feedback });
  }

  res.json({ success: true, addedCount, total: feedback.length });
});

// In-memory cache for campaign suggestions: branchId -> suggestions list
const campaignSuggestionsCache = {};

function getLocalCampaignSuggestions(profiles, feedback, branchId) {
  return profiles.map((p, idx) => {
    const name = p.name || 'Customer';
    const tier = p.loyaltyTier || ctx.getLoyaltyTier(p.visits);
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
app.get('/api/businesses/:id/ai-campaign-suggestions', requireAuth, requireBranchAccess, async (req, res) => {
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
app.post('/api/businesses/:id/ai-campaign-suggestions/:suggestionId/approve', requireAuth, requireBranchAccess, (req, res) => {
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
    emitToBranch(id, 'crm_update', { branchId: id, profiles });
  }
  
  // Broadcast simulated chat notification
  emitToBranch(id, 'inbound_chat', {
    branchId: id,
    phone: sug.customerPhone,
    text: `🎁 *[AI SMART CAMPAIGN]*: ${textToSend}`,
    sender: 'ai',
    timestamp: new Date().toLocaleTimeString()
  });
  
  // Send via WhatsApp if connected
  if (whatsappClient && whatsappConnectionStatus === 'Connected') {
    const wid = sug.customerPhone.includes('@') ? sug.customerPhone : `${sug.customerPhone}@c.us`;
    whatsappClient.sendMessage(wid, textToSend).catch(e => console.error('[WhatsApp AI Campaign Error]', e));
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
  saveMsg(id, phone, customerName||null, 'in', text, 'simulator');
  saveMsg(id, phone, customerName||null, 'out', reply, 'simulator');
  res.json({ success: true, reply });
});

// 12. Get custom offer requests
app.get('/api/businesses/:id/offers', requireAuth, requireBranchAccess, (req, res) => {
  res.json(getBranchData(req.params.id, 'offer_requests.json'));
});

// 13. Approve custom offer
app.post('/api/businesses/:id/offers/:offerId/approve', requireAuth, requireBranchAccess, (req, res) => {
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

  if (whatsappClient && whatsappConnectionStatus === 'Connected') {
    const wid = phone.includes('@') ? phone : `${phone}@c.us`;
    whatsappClient.sendMessage(wid, msgContent).catch(e => console.error('Send error', e));
  }

  // Emit chat response to simulated logs
  emitToBranch(id, 'inbound_chat', {
    branchId: id,
    phone: phone,
    text: `🔔 *[APPROVED CUSTOM OFFER]*: ${msgContent}`,
    sender: 'ai',
    timestamp: new Date().toLocaleTimeString()
  });

  emitToBranch(id, 'offers_update', { branchId: id, offers });
  res.json({ success: true, offers });
});

// 14. Reject custom offer
app.post('/api/businesses/:id/offers/:offerId/reject', requireAuth, requireBranchAccess, (req, res) => {
  const { id, offerId } = req.params;
  const offers = getBranchData(id, 'offer_requests.json');
  const index = offers.findIndex(o => o.id === offerId);
  if (index === -1) return res.status(404).json({ error: 'Offer request not found' });

  offers[index].status = 'rejected';
  writeBranchData(id, 'offer_requests.json', offers);

  const phone = offers[index].phone;
  const msgContent = `Sorry, we cannot offer any additional custom discount at this time. However, please check out our Tuesday Coffee specials! 😊☕`;

  if (whatsappClient && whatsappConnectionStatus === 'Connected') {
    const wid = phone.includes('@') ? phone : `${phone}@c.us`;
    whatsappClient.sendMessage(wid, msgContent).catch(e => console.error('Send error', e));
  }

  // Emit chat response to simulated logs
  emitToBranch(id, 'inbound_chat', {
    branchId: id,
    phone: phone,
    text: msgContent,
    sender: 'ai',
    timestamp: new Date().toLocaleTimeString()
  });

  emitToBranch(id, 'offers_update', { branchId: id, offers });
  res.json({ success: true, offers });
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

  if (!Client) { console.warn('[WhatsApp] Client not loaded, skipping init'); return; }
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
    saveMsg(activeRealBotBusinessId, fromPhone, null, 'in', incomingText, 'whatsapp');

    // Run response through AI NLP engine
    const reply = await processCafeBotReply(activeRealBotBusinessId, fromPhone, incomingText);

    // Send WhatsApp Outbound reply
    await msg.reply(reply);
    
    console.log(`[WhatsApp Outbound] To ${fromPhone}: "${reply}"`);
    saveMsg(activeRealBotBusinessId, fromPhone, null, 'out', reply, 'whatsapp');

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

// ── Chat history endpoint ──────────────────────────────────────────────────
app.get('/api/businesses/:id/chat-history', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const { phone, limit=200 } = req.query;
  if (phone) {
    const msgs = db.prepare('SELECT * FROM chat_messages WHERE business_id=? AND phone=? ORDER BY created_at ASC LIMIT ?').all(id, phone, +limit);
    return res.json(msgs);
  }
  const convos = db.prepare(`
    SELECT m.phone, m.customer_name, m.message as last_message, m.direction as last_direction, m.channel, m.created_at,
           (SELECT COUNT(*) FROM chat_messages c WHERE c.business_id=m.business_id AND c.phone=m.phone) as message_count
    FROM chat_messages m
    WHERE m.business_id=? AND m.id IN (
      SELECT MAX(id) FROM chat_messages WHERE business_id=? GROUP BY phone
    )
    ORDER BY m.created_at DESC LIMIT ?
  `).all(id, id, +limit);
  res.json(convos);
});

};
