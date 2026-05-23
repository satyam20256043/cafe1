const socket = io();

// Application State Variables
let currentTab = 'hq';
let businessesList = [];
let activeBranchId = null;
let activeSimPhoneNumber = '9123456789';
let isSimMode = true;

// -------------------------------------------------------------
// 🎛️ Navigation & Tab Management
// -------------------------------------------------------------
function switchTab(tabId) {
  // Hide all tabs
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav li').forEach(el => el.classList.remove('active'));

  // Show selected tab
  const activeTab = document.getElementById(`tab-${tabId}`);
  if (activeTab) activeTab.classList.add('active');

  const activeNav = document.getElementById(`nav-${tabId}`);
  if (activeNav) activeNav.classList.add('active');

  currentTab = tabId;

  // HQ tab aggregates all statistics
  if (tabId === 'hq') {
    fetchGlobalStatistics();
  } else if (tabId === 'franchises') {
    fetchBusinesses();
  } else if (tabId === 'marketing') {
    renderGlobalMarketingForm();
  }
}

// -------------------------------------------------------------
// 🏢 Business & Franchise Management
// -------------------------------------------------------------
async function fetchBusinesses() {
  try {
    const res = await fetch('/api/businesses');
    businessesList = await res.json();
    renderFranchiseGrid();
    renderHQBranchChart();
  } catch (err) {
    console.error('Error fetching businesses', err);
  }
}

function renderFranchiseGrid() {
  const grid = document.getElementById('franchises-grid');
  if (!grid) return;

  grid.innerHTML = '';
  businessesList.forEach(b => {
    const card = document.createElement('div');
    card.className = 'franchise-card';
    card.innerHTML = `
      <div class="franchise-header">
        <h3>${b.name}</h3>
        <div class="status-badge ${b.status}">
          <span class="pulse ${b.status === 'online' ? 'green' : 'red'}"></span> ${b.status}
        </div>
      </div>
      <div class="franchise-body">
        <div><strong>📍 Location:</strong> ${b.location}</div>
        <div><strong>⏰ Timing:</strong> ${b.timings}</div>
        <div><strong>📞 Contact:</strong> ${b.contact}</div>
        <div><strong>📶 Guest WiFi:</strong> ${b.wifi.split('/')[0]}</div>
      </div>
      <div class="franchise-footer">
        <button class="btn btn-primary" onclick="openBranchDeepdive('${b.id}')">⚙️ Manage Branch</button>
      </div>
    `;
    grid.appendChild(card);
  });
}

// Add Franchise Modal handlers
function openAddBusinessModal() {
  document.getElementById('add-business-modal').style.display = 'flex';
}

function closeAddBusinessModal() {
  document.getElementById('add-business-modal').style.display = 'none';
  document.getElementById('add-business-form').reset();
}

async function submitAddBusiness(e) {
  e.preventDefault();
  const name = document.getElementById('add-biz-name').value;
  const location = document.getElementById('add-biz-location').value;
  const timings = document.getElementById('add-biz-timings').value;
  const contact = document.getElementById('add-biz-contact').value;
  const wifi = document.getElementById('add-biz-wifi').value;
  const map = document.getElementById('add-biz-map').value;
  const review = document.getElementById('add-biz-review').value;

  try {
    const res = await fetch('/api/businesses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, location, timings, contact, wifi, map, review })
    });
    if (res.ok) {
      closeAddBusinessModal();
      fetchBusinesses();
    }
  } catch (err) {
    console.error('Error adding business', err);
  }
}

// -------------------------------------------------------------
// 🌿 Branch Deepdive operations
// -------------------------------------------------------------
async function openBranchDeepdive(id) {
  activeBranchId = id;
  const branch = businessesList.find(b => b.id === id);
  if (!branch) return;

  // Toggle active tab pane
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-branch-deepdive').classList.add('active');

  // Load branch meta into workspace view
  document.getElementById('deepdive-branch-title').innerText = `${branch.name} (${branch.location.split(',')[0]})`;
  document.getElementById('chat-title-branch').innerText = `${branch.name} Assistant`;

  // Pre-fill Forms
  document.getElementById('config-name').value = branch.name;
  document.getElementById('config-location').value = branch.location;
  document.getElementById('config-timings').value = branch.timings;
  document.getElementById('config-contact').value = branch.contact;
  document.getElementById('config-map').value = branch.map;
  document.getElementById('config-wifi').value = branch.wifi;
  document.getElementById('config-review').value = branch.review;

  // Load branch-specific operational files
  fetchBranchMenu();
  fetchBranchReservations();
  fetchBranchCampaigns();
  fetchBranchCrm();
  clearChatStream();
}

function exitBranchDeepdive() {
  activeBranchId = null;
  switchTab('hq');
}

// Save branch details form
async function saveBranchSettings(e) {
  e.preventDefault();
  if (!activeBranchId) return;

  const data = {
    name: document.getElementById('config-name').value,
    location: document.getElementById('config-location').value,
    timings: document.getElementById('config-timings').value,
    contact: document.getElementById('config-contact').value,
    map: document.getElementById('config-map').value,
    wifi: document.getElementById('config-wifi').value,
    review: document.getElementById('config-review').value
  };

  try {
    const res = await fetch(`/api/businesses/${activeBranchId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      alert('Bot settings updated successfully! 😊');
      fetchBusinesses();
    }
  } catch (err) {
    console.error('Error saving settings', err);
  }
}

// -------------------------------------------------------------
// 🍽️ Menu & Pricing Manager (Dynamic Pricing & Discounts)
// -------------------------------------------------------------
let activeMenu = [];

async function fetchBranchMenu() {
  if (!activeBranchId) return;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/menu`);
    activeMenu = await res.json();
    renderBranchMenuTable();
  } catch (err) {
    console.error('Error fetching menu', err);
  }
}

function renderBranchMenuTable() {
  const tbody = document.querySelector('#branch-menu-table tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  activeMenu.forEach((item, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${item.name}</strong></td>
      <td><span class="crm-tag">${item.category}</span></td>
      <td>
        <input type="number" class="form-select-sm" style="width:70px;" value="${item.price}" onchange="updateMenuItemInline(${index}, 'price', this.value)" />
      </td>
      <td>
        <input type="number" class="form-select-sm" style="width:60px;" value="${item.discount}" onchange="updateMenuItemInline(${index}, 'discount', this.value)" />
      </td>
      <td>
        <button class="btn-icon reject" onclick="deleteMenuItem(${index})">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function updateMenuItemInline(index, field, value) {
  activeMenu[index][field] = parseFloat(value);
  saveMenuDatabase();
}

async function deleteMenuItem(index) {
  if (confirm('Are you sure you want to remove this menu item?')) {
    activeMenu.splice(index, 1);
    saveMenuDatabase();
  }
}

async function saveMenuDatabase() {
  if (!activeBranchId) return;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/menu`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activeMenu)
    });
    if (res.ok) {
      renderBranchMenuTable();
    }
  } catch (err) {
    console.error('Error saving menu', err);
  }
}

// Add Item Modal handlers
function openAddMenuModal() {
  document.getElementById('add-menu-modal').style.display = 'flex';
}

function closeAddMenuModal() {
  document.getElementById('add-menu-modal').style.display = 'none';
  document.getElementById('add-menu-form').reset();
}

function submitAddMenuItem(e) {
  e.preventDefault();
  const name = document.getElementById('add-menu-name').value;
  const category = document.getElementById('add-menu-category').value;
  const price = parseFloat(document.getElementById('add-menu-price').value);
  const discount = parseFloat(document.getElementById('add-menu-discount').value) || 0;

  const newItem = { id: Date.now().toString(), name, category, price, discount };
  activeMenu.push(newItem);
  saveMenuDatabase();
  closeAddMenuModal();
}

// -------------------------------------------------------------
// 📅 Table Reservations Ledger
// -------------------------------------------------------------
async function fetchBranchReservations() {
  if (!activeBranchId) return;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/reservations`);
    const reservations = await res.json();
    renderReservationsTable(reservations);
  } catch (err) {
    console.error('Error fetching reservations', err);
  }
}

function renderReservationsTable(reservations) {
  const tbody = document.querySelector('#branch-reservations-table tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (reservations.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No reservations collected yet.</td></tr>`;
    return;
  }

  reservations.forEach(r => {
    const tr = document.createElement('tr');
    let statusClass = 'offline';
    if (r.status === 'approved') statusClass = 'online';

    let actionButtons = '';
    if (r.status === 'pending') {
      actionButtons = `
        <div class="ledger-actions">
          <button class="btn-icon approve" onclick="updateReservationStatus('${r.id}', 'approved')">✓</button>
          <button class="btn-icon reject" onclick="updateReservationStatus('${r.id}', 'cancelled')">✗</button>
        </div>
      `;
    } else {
      actionButtons = `<span class="text-muted small">${r.status.toUpperCase()}</span>`;
    }

    tr.innerHTML = `
      <td><strong>${r.name}</strong></td>
      <td>👤 ${r.guests} guests</td>
      <td>${r.datetime}</td>
      <td>
        <span class="status-badge ${statusClass}">${r.status}</span>
      </td>
      <td>${actionButtons}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function updateReservationStatus(resId, status) {
  if (!activeBranchId) return;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/reservations/${resId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (res.ok) {
      fetchBranchReservations();
    }
  } catch (err) {
    console.error('Error updating reservation', err);
  }
}

// -------------------------------------------------------------
// 🏷️ Low-Traffic Campaigns & CRM
// -------------------------------------------------------------
async function fetchBranchCampaigns() {
  if (!activeBranchId) return;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/analytics`);
    const data = await res.json();
    
    // Fill Campaigns
    const settingsRes = await fetch(`/api/businesses/${activeBranchId}`);
    const settings = await settingsRes.json();
    
    // Let's load settings configurations
    const fileRes = await fetch('/api/businesses');
    const bList = await fileRes.json();
    
    // Fallback settings read from JSON
    const branchSettings = await (await fetch(`/api/businesses/${activeBranchId}/crm`)).json();
  } catch (err) {}
}

async function fetchBranchCrm() {
  if (!activeBranchId) return;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/crm`);
    const profiles = await res.json();
    renderCrmTable(profiles);
  } catch (err) {
    console.error('Error loading CRM', err);
  }
}

function renderCrmTable(profiles) {
  const tbody = document.querySelector('#branch-crm-table tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (profiles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted">No customer profiles saved.</td></tr>`;
    return;
  }

  profiles.forEach(p => {
    const tr = document.createElement('tr');
    let tagsStr = '';
    p.tags.forEach(t => {
      const displayTag = t.replace(/_/g, ' ');
      tagsStr += `<span class="crm-tag">${displayTag}</span>`;
    });

    tr.innerHTML = `
      <td><strong>${p.name || 'Customer'}</strong><br/><span class="text-muted small">${p.phone}</span></td>
      <td>${p.visits} chats</td>
      <td>${tagsStr}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Save low-traffic campaigns
async function saveBranchCampaigns(e) {
  e.preventDefault();
  if (!activeBranchId) return;

  const lowTrafficCampaigns = [
    { day: 'Monday', offer: document.getElementById('camp-monday').value },
    { day: 'Tuesday', offer: document.getElementById('camp-tuesday').value },
    { day: 'Wednesday', offer: document.getElementById('camp-wednesday').value }
  ].filter(c => c.offer.trim() !== '');

  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lowTrafficCampaigns })
    });
    if (res.ok) {
      alert('Campaign schemes saved successfully! 🚀');
    }
  } catch (err) {
    console.error('Error saving campaigns', err);
  }
}

// Trigger simulated local marketing broadcast
function triggerCampaignBroadcast() {
  if (!activeBranchId) return;

  const targetTag = document.getElementById('broadcast-tag-select').value;
  const campaignText = document.getElementById('broadcast-text-area').value;

  if (!campaignText.trim()) {
    alert('Please enter promo campaign text.');
    return;
  }

  socket.emit('trigger_campaign_broadcast', {
    branchId: activeBranchId,
    campaignText,
    targetTag
  });
}

socket.on('campaign_broadcast_result', (data) => {
  if (data.success) {
    alert(`Success! Campaign broadcast completed. Broadcasted to ${data.logs.length} targets via WhatsApp. 😊`);
    document.getElementById('broadcast-text-area').value = '';
  }
});

// -------------------------------------------------------------
// 💬 Live Chat Console & Simulator (Interactive NLP Sandbox)
// -------------------------------------------------------------
function toggleSimMode() {
  isSimMode = document.getElementById('sim-mode-chk').checked;
  const presets = document.getElementById('quick-presets');
  if (isSimMode) {
    presets.style.opacity = '1';
    presets.style.pointerEvents = 'auto';
  } else {
    presets.style.opacity = '0.4';
    presets.style.pointerEvents = 'none';
  }
}

function clearChatStream() {
  const stream = document.getElementById('chat-stream');
  if (stream) {
    stream.innerHTML = `
      <div class="system-message">
        <span>Active & Automated. Choose a preset query below to test language rules, state machines, or pricing reasoning.</span>
      </div>
    `;
  }
}

function sendPresetText(text) {
  document.getElementById('chat-input-field').value = text;
  sendCustomMessage();
}

function handleChatInputKey(e) {
  if (e.key === 'Enter') sendCustomMessage();
}

function sendCustomMessage() {
  const field = document.getElementById('chat-input-field');
  const text = field.value.trim();
  if (!text || !activeBranchId) return;

  field.value = '';

  if (isSimMode) {
    // Local client-to-server WebSocket simulation loop
    socket.emit('simulate_chat', {
      branchId: activeBranchId,
      phone: activeSimPhoneNumber,
      text: text,
      customerName: 'Test Sim Customer'
    });
  } else {
    // If not in simulation mode, prompt that WhatsApp line needs to be linked
    appendChatBubble('system', 'System: Bot is in real WhatsApp Web mode. Send messages directly from a WhatsApp account to the linked line.');
  }
}

function appendChatBubble(sender, text, timestamp) {
  const stream = document.getElementById('chat-stream');
  if (!stream) return;

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${sender === 'customer' ? 'customer' : 'ai'}`;
  
  // Format linebreaks beautifully
  const formattedText = text.replace(/\n/g, '<br/>');
  
  bubble.innerHTML = `
    <div>${formattedText}</div>
    <div class="chat-bubble-meta">${timestamp || new Date().toLocaleTimeString()}</div>
  `;
  
  stream.appendChild(bubble);
  stream.scrollTop = stream.scrollHeight;
}

// -------------------------------------------------------------
// 🔌 whatsapp-web.js real integration connectors
// -------------------------------------------------------------
function startWhatsAppInstance() {
  if (!activeBranchId) return;
  const btn = document.getElementById('btn-start-wa');
  btn.innerText = '⚙️ Spawning WhatsApp worker...';
  btn.disabled = true;

  document.querySelector('.qr-loading-spinner').style.display = 'block';
  document.getElementById('qr-instructions').style.display = 'none';
  
  socket.emit('start_whatsapp', { branchId: activeBranchId });
}

// Listen for global WhatsApp connection state changes
socket.on('whatsapp_state', (data) => {
  const { status, qr, activeBusinessId, number } = data;
  
  // Only update UI if we are looking at the managed branch
  if (activeBranchId !== activeBusinessId) return;

  const badge = document.getElementById('deepdive-whatsapp-badge');
  const indicatorText = document.getElementById('wa-status-text');
  const qrImg = document.getElementById('wa-qr-img');
  const qrInstructions = document.getElementById('qr-instructions');
  const qrSpinner = document.querySelector('.qr-loading-spinner');
  const connectBtn = document.getElementById('btn-start-wa');

  indicatorText.innerHTML = `Status: <strong>${status}</strong> ${number ? `(${number})` : ''}`;

  if (status === 'Connected') {
    badge.className = 'branch-status-badge online';
    badge.innerHTML = `<span class="pulse green"></span> Connected`;
    
    qrImg.style.display = 'none';
    qrInstructions.style.display = 'block';
    qrInstructions.innerHTML = `<p class="green" style="color:var(--success-color); font-weight:600;">✅ Linked successfully!<br/>Line is live & automated.</p>`;
    qrSpinner.style.display = 'none';
    
    connectBtn.innerText = '🔌 WhatsApp Connected';
    connectBtn.className = 'btn btn-success w-100';
    connectBtn.disabled = true;
  } else if (status === 'Ready to Scan' && qr) {
    badge.className = 'branch-status-badge outline';
    badge.innerHTML = `<span class="pulse red"></span> Disconnected`;
    
    qrImg.src = qr;
    qrImg.style.display = 'block';
    qrInstructions.style.display = 'none';
    qrSpinner.style.display = 'none';
    
    connectBtn.innerText = 'Ready to Scan';
    connectBtn.disabled = true;
  } else if (status === 'Connecting...') {
    qrSpinner.style.display = 'block';
    qrInstructions.style.display = 'none';
    qrImg.style.display = 'none';
  } else {
    badge.className = 'branch-status-badge outline';
    badge.innerHTML = `<span class="pulse red"></span> Disconnected`;
    
    qrImg.style.display = 'none';
    qrInstructions.style.display = 'block';
    qrInstructions.innerHTML = `<p>Start connection to generate linking QR code</p>`;
    qrSpinner.style.display = 'none';
    
    connectBtn.innerText = '🔌 Connect WhatsApp Line';
    connectBtn.className = 'btn btn-success w-100';
    connectBtn.disabled = false;
  }
});

// -------------------------------------------------------------
// 📊 HQ Overview Chart & Statistics
// -------------------------------------------------------------
async function fetchGlobalStatistics() {
  try {
    const res = await fetch('/api/businesses');
    businessesList = await res.json();

    let combinedBookings = 0;
    let onlineCount = 0;

    // Load branch stats individually to aggregate
    for (const b of businessesList) {
      if (b.status === 'online') onlineCount++;
      const resData = await fetch(`/api/businesses/${b.id}/reservations`);
      const bookings = await resData.json();
      combinedBookings += bookings.length;
    }

    document.getElementById('kpi-total-cafes').innerText = businessesList.length;
    document.getElementById('kpi-total-bookings').innerText = combinedBookings;
    document.getElementById('kpi-active-bots').innerText = onlineCount;

    renderHQBranchChart();
    renderConsolidatedHeatmap();
  } catch (err) {
    console.error('Error computing SaaS stats', err);
  }
}

async function renderHQBranchChart() {
  const container = document.getElementById('hq-branch-chart');
  if (!container) return;

  container.innerHTML = '';
  
  // Fetch reservation lengths for each branch
  for (const b of businessesList) {
    try {
      const res = await fetch(`/api/businesses/${b.id}/reservations`);
      const bookings = await res.json();
      const count = bookings.length;

      const row = document.createElement('div');
      row.className = 'chart-bar-row';
      
      // Calculate width percentage relative to max of 10 for neat scaling
      const pct = Math.min((count / 10) * 100, 100);

      row.innerHTML = `
        <div class="chart-label">${b.name} (${b.location.split(',')[0]})</div>
        <div class="chart-bar-container">
          <div class="chart-bar-fill" style="width: ${pct}%"></div>
        </div>
        <div class="chart-value">${count}</div>
      `;
      container.appendChild(row);
    } catch (err) {}
  }
}

// Heatmap rendering
async function renderConsolidatedHeatmap() {
  const grid = document.getElementById('hq-heatmap-grid');
  if (!grid) return;

  grid.innerHTML = '';
  
  // Aggregate heatmaps from all branches
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const consolidatedTraffic = {};
  
  days.forEach(d => { consolidatedTraffic[d] = [0,0,0,0,0,0,0,0]; });

  for (const b of businessesList) {
    try {
      const res = await fetch(`/api/businesses/${b.id}/analytics`);
      const analytics = await res.json();
      if (analytics.traffic) {
        days.forEach(d => {
          for (let i = 0; i < 8; i++) {
            consolidatedTraffic[d][i] += (analytics.traffic[d][i] || 0);
          }
        });
      }
    } catch (e) {}
  }

  // Draw Column headers
  days.forEach(d => {
    const header = document.createElement('div');
    header.className = 'heatmap-col-header';
    header.innerText = d.substring(0, 3);
    grid.appendChild(header);
  });

  // Draw rows (8 hour buckets)
  for (let i = 0; i < 8; i++) {
    days.forEach(d => {
      const val = consolidatedTraffic[d][i];
      let level = 0;
      if (val >= 1 && val <= 5) level = 1;
      else if (val >= 6 && val <= 15) level = 2;
      else if (val >= 16 && val <= 30) level = 3;
      else if (val > 30) level = 4;

      const cell = document.createElement('div');
      cell.className = `heatmap-cell level-${level}`;
      cell.setAttribute('data-tooltip', `${d}: ${val} inquiries`);
      grid.appendChild(cell);
    });
  }
}

// -------------------------------------------------------------
// 📢 HQ Global Campaigns Manager
// -------------------------------------------------------------
function renderGlobalMarketingForm() {
  const container = document.getElementById('hq-campaign-branches');
  if (!container) return;

  container.innerHTML = '';
  businessesList.forEach(b => {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    label.innerHTML = `
      <input type="checkbox" name="global-branch-select" value="${b.id}" checked />
      ${b.name} (${b.location.split(',')[0]})
    `;
    container.appendChild(label);
  });
}

async function launchGlobalCampaign() {
  const selectedBranches = Array.from(document.querySelectorAll('input[name="global-branch-select"]:checked')).map(el => el.value);
  const discount = parseFloat(document.getElementById('global-discount-pct').value) || 0;
  const broadcastText = document.getElementById('global-broadcast-message').value.trim();

  if (selectedBranches.length === 0) {
    alert('Please select at least one branch.');
    return;
  }

  if (discount === 0 && !broadcastText) {
    alert('Please input a discount percentage or write a broadcast text campaign.');
    return;
  }

  let successCount = 0;

  for (const branchId of selectedBranches) {
    // 1. If discount is specified, globally adjust prices of bestsellers
    if (discount > 0) {
      try {
        const menuRes = await fetch(`/api/businesses/${branchId}/menu`);
        const menu = await menuRes.json();
        menu.forEach(item => { item.discount = discount; });
        await fetch(`/api/businesses/${branchId}/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(menu)
        });
      } catch (err) {}
    }

    // 2. If broadcast text is drafted, stream it to target socket broadcast
    if (broadcastText) {
      socket.emit('trigger_campaign_broadcast', {
        branchId,
        campaignText: broadcastText,
        targetTag: 'all'
      });
    }

    successCount++;
  }

  alert(`HQ Campaign Launched Successfully! 😊 Pushed promotional models and price adjustments to ${successCount} franchises.`);
  document.getElementById('global-discount-pct').value = '';
  document.getElementById('global-broadcast-message').value = '';
}

function openHqCampaign(day) {
  switchTab('marketing');
  document.getElementById('global-broadcast-message').value = `Hey there! ☕ Feeling the midweek slump? Drop by today and enjoy our special ${day} promotion! See you at the café! 😊`;
}

// -------------------------------------------------------------
// 📳 Real-time WebSockets Stream Receivers
// -------------------------------------------------------------

// Live message logging from WhatsApp bot / simulator
socket.on('inbound_chat', (data) => {
  const { branchId, phone, text, sender, timestamp } = data;
  
  // If we are deep diving into this specific branch, show in chat feed
  if (activeBranchId === branchId) {
    if (sender === 'ai') {
      document.getElementById('wa-typing-indicator').style.display = 'none';
      appendChatBubble('ai', text, timestamp);
    } else {
      appendChatBubble('customer', text, timestamp);
      // Simulate typing delay
      document.getElementById('wa-typing-indicator').style.display = 'flex';
      const container = document.getElementById('chat-stream');
      container.scrollTop = container.scrollHeight;
    }
    // Update local CRM table because customer visits/tags updated
    fetchBranchCrm();
  }
});

// Reactive updates for Ledgers and Heatmaps
socket.on('reservation_update', (data) => {
  const { branchId, reservations } = data;
  if (activeBranchId === branchId) {
    renderReservationsTable(reservations);
  }
  fetchGlobalStatistics();
});

socket.on('crm_update', (data) => {
  const { branchId, profiles } = data;
  if (activeBranchId === branchId) {
    renderCrmTable(profiles);
  }
});

socket.on('traffic_update', (data) => {
  fetchGlobalStatistics();
});

// On load initialization
window.addEventListener('load', () => {
  fetchBusinesses();
  fetchGlobalStatistics();
});
