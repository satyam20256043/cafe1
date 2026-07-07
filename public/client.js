const socket = io();
socket.on('connect', () => {
  // Agency admins join the 'agency' room and receive events from every branch
  socket.emit('join_business', { token: localStorage.getItem('cafehq_token') });
});

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
  } else if (tabId === 'staff') {
    if (typeof loadAllStaff === 'function') loadAllStaff();
  }
}

// -------------------------------------------------------------
// 🏢 Business & Franchise Management
// -------------------------------------------------------------
// Skeleton Loader Helpers
function setTableSkeleton(tbodyId, columnsCount, rowsCount = 3) {
  const tbody = document.querySelector(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = Array(rowsCount).fill(0).map(() => `
    <tr style="pointer-events: none;">
      <td colspan="${columnsCount}" style="padding: 12px 14px; background-color: var(--bg-overlay); border: none;">
        <div class="skeleton" style="height: 18px; margin: 4px 0; width: ${Math.floor(Math.random() * 40) + 50}%; border-radius: var(--radius-sm);"></div>
      </td>
    </tr>
  `).join('');
}

function setFranchiseGridSkeleton() {
  const grid = document.getElementById('franchises-grid');
  if (!grid) return;
  grid.innerHTML = Array(3).fill(0).map(() => `
    <div class="franchise-card" style="pointer-events: none;">
      <div class="franchise-header" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px;">
        <div class="skeleton" style="height: 20px; width: 140px; border-radius: var(--radius-sm);"></div>
        <div class="skeleton" style="height: 18px; width: 60px; border-radius: var(--radius-full);"></div>
      </div>
      <div class="franchise-body" style="font-size: 12.5px; color: var(--text-secondary); line-height: 1.65; margin-bottom: 18px;">
        <div class="skeleton" style="height: 14px; width: 180px; margin-bottom: 8px; border-radius: var(--radius-sm);"></div>
        <div class="skeleton" style="height: 14px; width: 150px; margin-bottom: 8px; border-radius: var(--radius-sm);"></div>
        <div class="skeleton" style="height: 14px; width: 160px; margin-bottom: 8px; border-radius: var(--radius-sm);"></div>
        <div class="skeleton" style="height: 14px; width: 120px; border-radius: var(--radius-sm);"></div>
      </div>
      <div class="franchise-footer" style="display: flex; gap: 8px;">
        <div class="skeleton" style="height: 34px; flex: 1; border-radius: var(--radius-sm);"></div>
        <div class="skeleton" style="height: 34px; flex: 1; border-radius: var(--radius-sm);"></div>
      </div>
    </div>
  `).join('');
}

async function fetchBusinesses() {
  setFranchiseGridSkeleton();
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
      <div class="franchise-footer" style="display: flex; gap: 8px;">
        <button class="btn btn-primary" onclick="openBranchDeepdive('${b.id}')" style="flex: 1;">⚙️ Manage Branch</button>
        <a class="btn btn-secondary" href="/cafe/${b.id}" target="_blank" style="text-decoration: none; display: inline-flex; align-items: center; justify-content: center; flex: 1; font-size: 13px; font-weight: 500;">🌐 View Website</a>
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

  // Populate Display Profile Card
  document.getElementById('profile-display-name').innerText = branch.name;
  document.getElementById('profile-display-location').innerText = branch.location;
  document.getElementById('profile-display-timings').innerText = branch.timings;
  document.getElementById('profile-display-contact').innerText = branch.contact;
  document.getElementById('profile-display-wifi').innerText = branch.wifi;
  document.getElementById('profile-display-map').href = branch.map;
  document.getElementById('profile-display-review').href = branch.review;
  document.getElementById('profile-display-website').href = `/cafe/${branch.id}`;
  document.getElementById('profile-display-manager').href = `/manager/${branch.id}`;

  // Load branch-specific operational files
  fetchBranchMenu();
  fetchBranchReservations();
  fetchBranchCampaigns();
  fetchBranchCrm();
  fetchBranchOffers();
  fetchBranchFeedback();
  fetchAICampaignSuggestions();
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
      // Fetch updated list and refresh the active profile display card
      const bRes = await fetch('/api/businesses');
      businessesList = await bRes.json();
      const updatedBranch = businessesList.find(b => b.id === activeBranchId);
      if (updatedBranch) {
        document.getElementById('profile-display-name').innerText = updatedBranch.name;
        document.getElementById('profile-display-location').innerText = updatedBranch.location;
        document.getElementById('profile-display-timings').innerText = updatedBranch.timings;
        document.getElementById('profile-display-contact').innerText = updatedBranch.contact;
        document.getElementById('profile-display-wifi').innerText = updatedBranch.wifi;
        document.getElementById('profile-display-map').href = updatedBranch.map;
        document.getElementById('profile-display-review').href = updatedBranch.review;
        document.getElementById('profile-display-website').href = `/cafe/${updatedBranch.id}`;
        document.getElementById('profile-display-manager').href = `/manager/${updatedBranch.id}`;
        
        document.getElementById('deepdive-branch-title').innerText = `${updatedBranch.name} (${updatedBranch.location.split(',')[0]})`;
      }
      renderFranchiseGrid();
      fetchBranchCampaigns();
      fetchBranchFeedback();
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
  setTableSkeleton('#branch-menu-table tbody', 5);
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
  setTableSkeleton('#branch-reservations-table tbody', 5);
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
      <td><strong>${r.name}</strong><br/><span class="text-muted small">${r.phone || 'N/A'}</span></td>
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
// 🔔 Custom Discount/Offer Approvals Workflow
// -------------------------------------------------------------
async function fetchBranchOffers() {
  if (!activeBranchId) return;
  setTableSkeleton('#branch-offers-tbody', 4);
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/offers`);
    const offers = await res.json();
    renderOffersTable(offers);
  } catch (err) {
    console.error('Error fetching custom offers', err);
  }
}

function renderOffersTable(offers) {
  const tbody = document.getElementById('branch-offers-tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (offers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No pending custom offer requests.</td></tr>`;
    return;
  }

  offers.forEach(o => {
    const tr = document.createElement('tr');
    
    let statusBadgeHtml = '';
    let actionsHtml = '';
    
    if (o.status === 'pending') {
      const defaultText = `Congratulations! The manager has approved a custom 15% discount for your table. Show code DISCOUNT15 at checkout! 🎟️`;
      statusBadgeHtml = `<span class="status-badge offline">Pending</span>`;
      actionsHtml = `
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="text" class="form-select-sm" id="offer-input-${o.id}" value="${defaultText}" style="width: 250px; height: 32px;" />
          <button class="btn-success-sm" onclick="approveOffer('${o.id}')">Approve & Send</button>
          <button class="btn-danger-outline-sm" onclick="rejectOffer('${o.id}')">Reject</button>
        </div>
      `;
    } else if (o.status === 'approved') {
      statusBadgeHtml = `<span class="status-badge online">Approved</span>`;
      actionsHtml = `<span class="text-muted small" title="${o.approvedOffer}">Sent: "${o.approvedOffer.substring(0, 35)}..."</span>`;
    } else {
      statusBadgeHtml = `<span class="status-badge outline" style="color:var(--text-muted); border-color:var(--border-color-solid)">Rejected</span>`;
      actionsHtml = `<span class="text-muted small">Politely declined</span>`;
    }

    tr.innerHTML = `
      <td><strong>${o.customerName || 'Valued Customer'}</strong><br/><span class="text-muted small">${o.phone}</span></td>
      <td><span style="font-style: italic;">"${o.requestText}"</span></td>
      <td>${actionsHtml}</td>
      <td>${statusBadgeHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function approveOffer(offerId) {
  if (!activeBranchId) return;
  const inputEl = document.getElementById(`offer-input-${offerId}`);
  const customText = inputEl ? inputEl.value : '';
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/offers/${offerId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customText })
    });
    if (res.ok) {
      fetchBranchOffers();
    }
  } catch (err) {
    console.error('Error approving offer', err);
  }
}

async function rejectOffer(offerId) {
  if (!activeBranchId) return;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/offers/${offerId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      fetchBranchOffers();
    }
  } catch (err) {
    console.error('Error rejecting offer', err);
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
    const settings = data.settings;
    if (settings) {
      // Populate low traffic campaign specials inputs
      const mondayCamp = settings.lowTrafficCampaigns.find(c => c.day === 'Monday');
      const tuesdayCamp = settings.lowTrafficCampaigns.find(c => c.day === 'Tuesday');
      const wednesdayCamp = settings.lowTrafficCampaigns.find(c => c.day === 'Wednesday');
      
      document.getElementById('camp-monday').value = mondayCamp ? mondayCamp.offer : '';
      document.getElementById('camp-tuesday').value = tuesdayCamp ? tuesdayCamp.offer : '';
      document.getElementById('camp-wednesday').value = wednesdayCamp ? wednesdayCamp.offer : '';

      // Populate Auto-Pilot controls
      const apToggle = document.getElementById('autopilot-toggle');
      if (apToggle) {
        apToggle.checked = !!settings.autoPilotActive;
      }
      
      const apStatusText = document.getElementById('autopilot-status-text');
      if (apStatusText) {
        if (settings.autoPilotActive) {
          const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
          const todayCamp = settings.lowTrafficCampaigns.find(c => c.day.toLowerCase() === today.toLowerCase());
          if (todayCamp) {
            apStatusText.innerHTML = `Status: <strong class="green" style="color:var(--success-color)">Active & Ready</strong> (Targeting slow days: ${todayCamp.day})`;
          } else {
            apStatusText.innerHTML = `Status: <strong class="green" style="color:var(--success-color)">Active & Ready</strong> (Watching traffic)`;
          }
        } else {
          apStatusText.innerHTML = `Status: <strong class="red" style="color:var(--error-color)">Disabled</strong>`;
        }
      }

      // Populate Google Business Profile status
      const gbpBadge = document.getElementById('gbp-connection-status');
      const gbpForm = document.getElementById('gbp-linker-form');
      const gbpInfo = document.getElementById('gbp-linked-info');
      const gbpLinkedId = document.getElementById('gbp-linked-id');
      const syncBtn = document.getElementById('btn-sync-gbp');

      if (settings.gbpLinked) {
        if (gbpBadge) {
          gbpBadge.className = 'status-badge online';
          gbpBadge.innerText = 'Linked';
        }
        if (gbpForm) gbpForm.style.display = 'none';
        if (gbpInfo) {
          gbpInfo.style.display = 'flex';
          gbpLinkedId.innerText = `Location ID: ${settings.gbpLocationId}`;
        }
        if (syncBtn) syncBtn.style.display = 'block';
      } else {
        if (gbpBadge) {
          gbpBadge.className = 'status-badge outline';
          gbpBadge.innerText = 'Disconnected';
        }
        if (gbpForm) gbpForm.style.display = 'flex';
        if (gbpInfo) gbpInfo.style.display = 'none';
        if (syncBtn) syncBtn.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Error fetching campaigns', err);
  }
}

async function fetchBranchCrm() {
  if (!activeBranchId) return;
  setTableSkeleton('#branch-crm-table tbody', 3);
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

    let ratingStr = '';
    if (p.averageRating > 0) {
      ratingStr = ` <span style="color: var(--accent-amber); font-weight: 500;" title="Average Rating: ${p.averageRating}★ (${p.feedbackCount} reviews)">★ ${p.averageRating}</span>`;
    }

    // Determine loyalty tier badge styling
    const tier = p.loyaltyTier || 'New Customer';
    let tierColor = '#8A7E80'; // grey
    let tierBg = 'rgba(255,255,255,0.04)';
    let tierText = '#8A7E80';
    if (tier === 'Elite') {
      tierColor = '#EF4444'; // crimson/red
      tierBg = 'rgba(239, 68, 68, 0.15)';
      tierText = '#EF4444';
    } else if (tier === 'VIP') {
      tierColor = '#F59E0B'; // gold/amber
      tierBg = 'rgba(245, 158, 11, 0.15)';
      tierText = '#F59E0B';
    } else if (tier === 'Regular') {
      tierColor = '#3B82F6'; // blue
      tierBg = 'rgba(59, 130, 246, 0.15)';
      tierText = '#3B82F6';
    }
    
    const tierBadge = `<span class="status-badge" style="font-size: 9px; padding: 2px 8px; border-radius: 12px; font-weight: bold; background: ${tierBg}; color: ${tierText}; border: 1px solid ${tierColor}; margin-left: 8px;">${tier}</span>`;

    tr.innerHTML = `
      <td><strong>${p.name || 'Customer'}</strong>${ratingStr}${tierBadge}<br/><span class="text-muted small">${p.phone}</span></td>
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
  let bubbleClass = sender === 'customer' ? 'customer' : 'ai';
  if (text.includes('[APPROVED CUSTOM OFFER]')) {
    bubbleClass = 'ai-approved-offer';
  }
  bubble.className = `chat-bubble ${bubbleClass}`;
  
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
  const { status, qr, activeBusinessId, number, geminiActive } = data;
  
  const aiBadge = document.getElementById('deepdive-ai-badge');
  if (aiBadge) {
    if (geminiActive) {
      aiBadge.className = 'branch-status-badge online';
      aiBadge.innerHTML = `<span class="pulse green-active"></span> GEMINI LLM ACTIVE`;
    } else {
      aiBadge.className = 'branch-status-badge outline';
      aiBadge.innerHTML = `<span class="pulse yellow"></span> LOCAL AI ACTIVE`;
    }
  }
  
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

socket.on('new_offer_request', (data) => {
  const { branchId, request } = data;
  if (activeBranchId === branchId) {
    fetchBranchOffers();
  }
});

socket.on('offers_update', (data) => {
  const { branchId, offers } = data;
  if (activeBranchId === branchId) {
    renderOffersTable(offers);
  }
});

socket.on('feedback_update', (data) => {
  const { branchId, feedback } = data;
  if (activeBranchId === branchId) {
    renderFeedbackTable(feedback);
  }
});

// Auto-Pilot control interactions
async function toggleAutoPilotState() {
  if (!activeBranchId) return;
  const active = document.getElementById('autopilot-toggle').checked;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/autopilot/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active })
    });
    if (res.ok) {
      fetchBranchCampaigns();
    }
  } catch (err) {
    console.error('Error toggling autopilot', err);
  }
}

async function triggerAutoPilotCampaign() {
  if (!activeBranchId) return;
  try {
    const forceDay = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const res = await fetch(`/api/businesses/${activeBranchId}/autopilot/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceDay })
    });
    const result = await res.json();
    if (result.success && result.result) {
      const runResult = result.result;
      if (runResult.count > 0) {
        alert(`⚡ Auto-Pilot Campaign triggered successfully! Target count: ${runResult.count}. Promos broadcasted successfully.`);
      } else {
        alert(`⚡ Auto-Pilot Check completed: No eligible target customers matched today's criteria (either tag-mismatch or within 48h limit).`);
      }
      fetchBranchCrm();
    } else {
      alert(`⚡ Auto-Pilot: Skipped. Reason: ${result.result ? result.result.reason : 'unknown'}`);
    }
  } catch (err) {
    console.error('Error triggering autopilot', err);
  }
}

// Feedback fetching & rendering
async function fetchBranchFeedback() {
  if (!activeBranchId) return;
  setTableSkeleton('#branch-feedback-tbody', 4);
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/feedback`);
    const feedback = await res.json();
    renderFeedbackTable(feedback);
  } catch (err) {
    console.error('Error fetching feedback', err);
  }
}

function renderFeedbackTable(feedback) {
  const tbody = document.getElementById('branch-feedback-tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (!feedback || feedback.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No feedback recorded yet.</td></tr>`;
    return;
  }

  const sortedFeedback = [...feedback].reverse();

  sortedFeedback.forEach(f => {
    const tr = document.createElement('tr');
    
    let starsHtml = '';
    for (let i = 1; i <= 5; i++) {
      if (i <= f.rating) {
        starsHtml += `<span style="color: var(--accent-amber);">★</span>`;
      } else {
        starsHtml += `<span style="color: var(--border-color-solid);">★</span>`;
      }
    }

    const sourceClass = f.source === 'google' ? 'online' : 'outline';
    const sourceLabel = f.source === 'google' ? '🌐 Google' : '💬 WhatsApp';
    const sourceBadge = `<span class="status-badge ${sourceClass}" style="font-size: 8px; padding: 1px 6px; margin-left: 8px; vertical-align: middle;">${sourceLabel}</span>`;

    // Render reply area if manager reply exists
    let replyHtml = '';
    if (f.managerReply) {
      replyHtml = `<div style="margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.05); border-left: 2px solid var(--accent-coffee); font-size: 12px; color: var(--text-primary); border-radius: 4px;">
        <strong>Reply:</strong> ${f.managerReply} <span class="text-muted" style="font-size:10px; margin-left: 6px;">(${f.replyTimestamp || ''})</span>
      </div>`;
    }

    tr.innerHTML = `
      <td><strong>${f.customerName}</strong>${sourceBadge}</td>
      <td><div style="font-size:16px;">${starsHtml} (${f.rating})</div></td>
      <td>
        <span style="font-style: italic;">"${f.comment}"</span>
        ${replyHtml}
      </td>
      <td><span class="text-muted small">${f.timestamp}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// Google Business Profile linking
async function linkGoogleBusinessProfile() {
  if (!activeBranchId) return;
  const locId = document.getElementById('gbp-location-id').value.trim();
  if (!locId) {
    alert('Please enter a Google Business Profile Location ID!');
    return;
  }
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/gbp/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: locId })
    });
    if (res.ok) {
      alert('Google Business Profile linked successfully! 🎉');
      document.getElementById('gbp-location-id').value = '';
      fetchBranchCampaigns();
      fetchBranchFeedback();
    }
  } catch (err) {
    console.error('Error linking GBP', err);
  }
}

async function unlinkGoogleBusinessProfile() {
  if (!activeBranchId) return;
  if (!confirm('Are you sure you want to disconnect Google Business Profile?')) return;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/gbp/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: null })
    });
    if (res.ok) {
      alert('Google Business Profile disconnected.');
      fetchBranchCampaigns();
      fetchBranchFeedback();
    }
  } catch (err) {
    console.error('Error unlinking GBP', err);
  }
}

async function syncGoogleReviews() {
  if (!activeBranchId) return;
  const btn = document.getElementById('btn-sync-gbp');
  const originalText = btn.innerText;
  btn.innerText = '⏳ Syncing...';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/gbp/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await res.json();
    if (res.ok) {
      if (result.addedCount > 0) {
        alert(`🔄 Sync Completed! Imported ${result.addedCount} customer reviews from Google Business Profile.`);
      } else {
        alert(`🔄 Sync Completed! Google Business Profile is already fully up to date.`);
      }
      fetchBranchFeedback();
    }
  } catch (err) {
    console.error('Error syncing GBP reviews', err);
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
}

// Theme mode toggle function
function toggleThemeMode() {
  const toggle = document.getElementById('theme-mode-toggle');
  if (!toggle) return;
  const isLight = toggle.checked;
  if (isLight) {
    document.body.classList.add('light-mode');
    localStorage.setItem('theme-mode', 'light');
  } else {
    document.body.classList.remove('light-mode');
    localStorage.setItem('theme-mode', 'dark');
  }
}

// On load initialization
window.addEventListener('load', () => {
  fetchBusinesses();
  fetchGlobalStatistics();
  
  const savedTheme = localStorage.getItem('theme-mode') || 'dark';
  const toggle = document.getElementById('theme-mode-toggle');
  if (toggle) {
    toggle.checked = (savedTheme === 'light');
  }
  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
  } else {
    document.body.classList.remove('light-mode');
  }

  // Setup command palette input search event listener
  const searchInput = document.getElementById('command-palette-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      commandPaletteSelectedIndex = 0;
      renderCommandPaletteItems();
    });
  }
});

// ── Command Palette JS Mechanics ─────────────────────────
let commandPaletteSelectedIndex = 0;
let commandPaletteItems = [];

// Show/Hide Palette
function toggleCommandPalette(show) {
  const palette = document.getElementById('command-palette');
  if (!palette) return;

  if (show) {
    palette.style.display = 'flex';
    document.getElementById('command-palette-input').value = '';
    document.getElementById('command-palette-input').focus();
    renderCommandPaletteItems();
  } else {
    palette.style.display = 'none';
  }
}

// Intercept ⌘K and Ctrl+K
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    const palette = document.getElementById('command-palette');
    if (palette && palette.style.display === 'flex') {
      toggleCommandPalette(false);
    } else {
      toggleCommandPalette(true);
    }
  }

  // Handle keys while palette is open
  const palette = document.getElementById('command-palette');
  if (palette && palette.style.display === 'flex') {
    if (e.key === 'Escape') {
      e.preventDefault();
      toggleCommandPalette(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCommandPaletteSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCommandPaletteSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeSelectedCommand();
    }
  }
});

// Hide on clicking outside the card
document.addEventListener('click', (e) => {
  const palette = document.getElementById('command-palette');
  if (palette && e.target === palette) {
    toggleCommandPalette(false);
  }
});

// Setup list of commands
function getCommandList() {
  const commands = [
    { icon: '📊', name: 'Go to Global HQ Dashboard', shortcut: 'HQ', action: () => switchTab('hq') },
    { icon: '🏢', name: 'Go to Manage Franchises', shortcut: 'FR', action: () => switchTab('franchises') },
    { icon: '📢', name: 'Go to HQ Campaign Hub', shortcut: 'CH', action: () => switchTab('marketing') },
    { icon: '⚙️', name: 'Go to System Settings', shortcut: 'SS', action: () => switchTab('settings') },
    { icon: '🌓', name: 'Toggle Light / Dark Mode', shortcut: 'TH', action: () => {
        const toggle = document.getElementById('theme-mode-toggle');
        if (toggle) {
          toggle.checked = !toggle.checked;
          toggleThemeMode();
        }
      } 
    }
  ];

  // Dynamically add linked cafes
  businessesList.forEach(b => {
    commands.push({
      icon: '☕',
      name: `Manage Branch: ${b.name} (${b.location.split(',')[0]})`,
      shortcut: b.id.toUpperCase(),
      action: () => openBranchDeepdive(b.id)
    });
  });

  return commands;
}

// Render filtered commands
function renderCommandPaletteItems() {
  const searchInput = document.getElementById('command-palette-input');
  if (!searchInput) return;
  const query = searchInput.value.toLowerCase().trim();
  const allCommands = getCommandList();

  // Filter commands by query
  commandPaletteItems = allCommands.filter(c => 
    c.name.toLowerCase().includes(query) || 
    c.shortcut.toLowerCase().includes(query)
  );

  if (commandPaletteSelectedIndex >= commandPaletteItems.length) {
    commandPaletteSelectedIndex = Math.max(0, commandPaletteItems.length - 1);
  }

  const listContainer = document.getElementById('command-palette-list');
  if (!listContainer) return;

  listContainer.innerHTML = '';

  if (commandPaletteItems.length === 0) {
    listContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">No commands found matching query</div>';
    return;
  }

  commandPaletteItems.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = `command-palette-item ${idx === commandPaletteSelectedIndex ? 'selected' : ''}`;
    item.innerHTML = `
      <div class="command-palette-item-left">
        <span class="command-palette-item-icon">${c.icon}</span>
        <span>${c.name}</span>
      </div>
      <span class="command-palette-shortcut">${c.shortcut}</span>
    `;
    item.addEventListener('click', () => {
      c.action();
      toggleCommandPalette(false);
    });
    listContainer.appendChild(item);
  });
}

// Move command selection
function moveCommandPaletteSelection(direction) {
  if (commandPaletteItems.length === 0) return;
  commandPaletteSelectedIndex = (commandPaletteSelectedIndex + direction + commandPaletteItems.length) % commandPaletteItems.length;
  renderCommandPaletteItems();

  // Ensure selected item is visible (scroll into view)
  const listContainer = document.getElementById('command-palette-list');
  const selectedNode = listContainer.children[commandPaletteSelectedIndex];
  if (selectedNode) {
    selectedNode.scrollIntoView({ block: 'nearest' });
  }
}

// Execute selected command
function executeSelectedCommand() {
  const command = commandPaletteItems[commandPaletteSelectedIndex];
  if (command) {
    command.action();
    toggleCommandPalette(false);
  }
}

// ── AI Campaign Suggestions JS Mechanics ─────────────────
async function fetchAICampaignSuggestions() {
  const loadingEl = document.getElementById('ai-campaigns-loading');
  const container = document.getElementById('ai-suggestions-container');
  
  if (loadingEl) loadingEl.style.display = 'block';
  if (container) container.innerHTML = '';
  
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/ai-campaign-suggestions`);
    const suggestions = await res.json();
    renderAICampaigns(suggestions);
  } catch (err) {
    console.error('Error fetching AI campaign suggestions', err);
    if (container) {
      container.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">Failed to load AI suggestions. Please try again later.</div>`;
    }
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

function renderAICampaigns(suggestions) {
  const container = document.getElementById('ai-suggestions-container');
  if (!container) return;
  
  container.innerHTML = '';
  if (suggestions.length === 0) {
    container.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">No customer profiles captured yet to generate campaigns.</div>`;
    return;
  }
  
  suggestions.forEach(sug => {
    const card = document.createElement('div');
    card.className = 'bg-espresso-light';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.marginBottom = '12px';
    
    // Loyalty Tier badge colors
    const tier = sug.loyaltyTier || 'New Customer';
    let tierColor = '#8A7E80'; // grey
    let tierBg = 'rgba(255,255,255,0.04)';
    let tierText = '#8A7E80';
    if (tier === 'Elite') {
      tierColor = '#EF4444'; // crimson/red
      tierBg = 'rgba(239, 68, 68, 0.15)';
      tierText = '#EF4444';
    } else if (tier === 'VIP') {
      tierColor = '#F59E0B'; // gold/amber
      tierBg = 'rgba(245, 158, 11, 0.15)';
      tierText = '#F59E0B';
    } else if (tier === 'Regular') {
      tierColor = '#3B82F6'; // blue
      tierBg = 'rgba(59, 130, 246, 0.15)';
      tierText = '#3B82F6';
    }
    
    const isApproved = sug.status === 'approved';
    const btnText = isApproved ? 'Sent Successfully' : '✅ Approve & Send';
    const btnClass = isApproved ? 'btn btn-primary btn-sm w-100 disabled' : 'btn btn-primary btn-sm w-100';
    const btnDisabledAttr = isApproved ? 'disabled' : '';
    
    card.innerHTML = `
      <div>
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
          <div>
            <h4 style="margin:0; font-size:13px; color:#fff; font-weight: 600;">${sug.customerName}</h4>
            <small style="color:var(--text-secondary); font-size: 11px;">${sug.customerPhone}</small>
          </div>
          <span class="status-badge" style="font-size: 9px; padding: 2px 8px; border-radius: 12px; font-weight: bold; background: ${tierBg}; color: ${tierText}; border: 1px solid ${tierColor};">${tier}</span>
        </div>
        
        <div style="margin-bottom:12px; padding:10px; background:rgba(255, 255, 255, 0.03); border-radius:var(--radius-sm); border-left:3px solid var(--accent);">
          <strong style="font-size:10px; text-transform:uppercase; color:var(--accent); display:block; margin-bottom:4px; letter-spacing: 0.5px;">Customer Psychology</strong>
          <p style="font-size:11.5px; color:var(--text-secondary); margin:0; line-height:1.4;">${sug.psychology}</p>
        </div>
        
        <div class="form-group" style="margin-bottom:12px;">
          <label style="font-size:10px; text-transform:uppercase; color:var(--text-muted); display:block; margin-bottom:6px; font-weight: 600; letter-spacing: 0.5px;">Draft Campaign Text</label>
          <textarea id="sug-text-${sug.id}" rows="3" ${isApproved ? 'readonly' : ''} style="width:100%; background:var(--bg-overlay); border:1px solid var(--border); color:#fff; padding:8px 10px; border-radius:var(--radius-sm); font-size:12px; resize:vertical; line-height:1.4; outline:none; transition: border-color var(--ease);">${sug.offerText}</textarea>
        </div>
      </div>
      
      <div style="display:flex; gap:10px; border-top:1px solid var(--border); padding-top:10px; margin-top:auto;">
        <button class="${btnClass}" ${btnDisabledAttr} id="btn-approve-${sug.id}" onclick="approveAICampaign('${sug.id}')">${btnText}</button>
      </div>
    `;
    container.appendChild(card);
  });
}

async function approveAICampaign(suggestionId) {
  const textarea = document.getElementById(`sug-text-${suggestionId}`);
  const btn = document.getElementById(`btn-approve-${suggestionId}`);
  if (!textarea || !btn) return;
  
  const customOfferText = textarea.value;
  btn.innerText = 'Processing...';
  btn.disabled = true;
  
  try {
    const res = await fetch(`/api/businesses/${activeBranchId}/ai-campaign-suggestions/${suggestionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customOfferText })
    });
    const result = await res.json();
    if (result.success) {
      btn.innerText = 'Sent Successfully';
      btn.classList.add('disabled');
      textarea.readOnly = true;
    } else {
      btn.innerText = 'Error Sending';
      btn.disabled = false;
    }
  } catch (err) {
    console.error('Error approving campaign suggestion', err);
    btn.innerText = 'Error Sending';
    btn.disabled = false;
  }
}

// ── Admin Billing Dashboard ───────────────────────────────────────────────────
async function loadBilling() {
  const token = document.getElementById('admin-token-input')?.value?.trim();
  if (!token) { alert('Enter your Admin Token first'); return; }

  // Store token in sessionStorage for convenience
  sessionStorage.setItem('admin_token', token);

  const show = id => { const el = document.getElementById(id); if(el) el.style.display=''; };
  const hide = id => { const el = document.getElementById(id); if(el) el.style.display='none'; };
  const set  = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };

  hide('billing-kpis'); hide('billing-branches'); hide('billing-customers'); hide('billing-error');

  try {
    const [billingRes, customersRes] = await Promise.all([
      fetch('/api/admin/billing',    { headers: { 'x-admin-token': token } }),
      fetch('/api/admin/customers',  { headers: { 'x-admin-token': token } })
    ]);

    if (!billingRes.ok) { show('billing-error'); return; }

    const billing   = await billingRes.json();
    const customers = customersRes.ok ? await customersRes.json() : [];
    const fmt = n => '\u20b9' + Math.round(n||0).toLocaleString('en-IN');
    const t = billing.totals || {};

    // KPI cards
    set('b-today-rev',   fmt(t.today_revenue));
    set('b-today-orders', (t.today_orders||0) + ' orders today');
    set('b-week-rev',    fmt(t.week_revenue));
    set('b-month-rev',   fmt(t.month_revenue));
    set('b-total-rev',   fmt(t.total_revenue));
    set('b-total-orders', (t.total_orders||0) + ' total orders');
    show('billing-kpis');

    // Per-branch table
    const tbody = document.getElementById('billing-tbody');
    if (tbody) {
      tbody.innerHTML = (billing.branches || []).map(b => `
        <tr>
          <td><strong>${b.name || b.business_id}</strong></td>
          <td>${fmt(b.today_revenue)}</td>
          <td>${fmt(b.week_revenue)}</td>
          <td>${fmt(b.month_revenue)}</td>
          <td>${fmt(b.total_revenue)}</td>
          <td>${b.total_orders || 0}</td>
        </tr>`).join('') || '<tr><td colspan="6" style="color:#bbb;text-align:center">No paid orders yet</td></tr>';
    }
    show('billing-branches');

    // Top customers
    const ctbody = document.getElementById('top-customers-tbody');
    if (ctbody && customers.length) {
      ctbody.innerHTML = customers.slice(0,20).map((c,i) => `
        <tr>
          <td>${i+1}. ${c.name||'—'}</td>
          <td>${c.phone}</td>
          <td>${c.branchName||c.business_id}</td>
          <td>${c.visits}</td>
          <td><strong>${fmt(c.total_spend)}</strong></td>
          <td>${c.last_visit ? new Date(c.last_visit).toLocaleDateString('en-IN') : '—'}</td>
        </tr>`).join('');
      show('billing-customers');
    }

    // Populate P&L + GST branch dropdowns with real branch list
    if (billing.branches && billing.branches.length) {
      initAccountingControls(billing.branches);
    }

  } catch(e) {
    show('billing-error');
    console.error('[Admin billing]', e);
  }
}

// Auto-load billing if token stored from previous visit
document.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorage.getItem('admin_token');
  if (saved) {
    const inp = document.getElementById('admin-token-input');
    if (inp) { inp.value = saved; }
  }
});

// ── P&L + GST Reports ─────────────────────────────────────────────────────────
function initAccountingControls(branches) {
  // Populate branch dropdowns
  ['pl-branch','gst-branch'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const isGst = id === 'gst-branch';
    if (!isGst) el.innerHTML = '<option value="all">All Branches</option>';
    else        el.innerHTML = '<option value="">Select Branch</option>';
    branches.forEach(b => {
      el.innerHTML += `<option value="${b.business_id||b.id}">${b.name||b.business_id}</option>`;
    });
  });

  // Default P&L dates — this month
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const from = document.getElementById('pl-from');
  const to   = document.getElementById('pl-to');
  if (from) from.value = `${y}-${String(m+1).padStart(2,'0')}-01`;
  if (to)   to.value   = now.toISOString().slice(0,10);

  // GST month/year dropdowns
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const gstMonth = document.getElementById('gst-month');
  const gstYear  = document.getElementById('gst-year');
  if (gstMonth) gstMonth.innerHTML = months.map((mn,i)=>`<option value="${i+1}"${i===m?' selected':''}>${mn}</option>`).join('');
  if (gstYear)  gstYear.innerHTML  = [y-1,y].map(yr=>`<option value="${yr}"${yr===y?' selected':''}>${yr}</option>`).join('');

  // Show sections
  const plS  = document.getElementById('pl-section');
  const gstS = document.getElementById('gst-section');
  if (plS)  plS.style.display  = '';
  if (gstS) gstS.style.display = '';
}

async function loadPL() {
  const token    = sessionStorage.getItem('admin_token');
  const branchSel= document.getElementById('pl-branch')?.value;
  const from     = document.getElementById('pl-from')?.value;
  const to       = document.getElementById('pl-to')?.value;
  const body     = document.getElementById('pl-body');
  if (!token) { alert('Load billing data first to authenticate'); return; }
  if (body) body.innerHTML = '<div style="color:#bbb;text-align:center;padding:20px">Loading...</div>';

  const fmt = n => '₹' + Math.round(n||0).toLocaleString('en-IN');

  try {
    let data;
    if (branchSel === 'all') {
      const res = await fetch(`/api/admin/accounting/pl-all?from=${from||''}&to=${to||''}`, { headers: { 'x-admin-token': token } });
      const arr = await res.json();
      // Aggregate
      const agg = { revenue: {}, expenses: { byCategory: {}, total: 0 }, summary: {} };
      let totRev=0, totExp=0, totOrders=0;
      arr.forEach(b => {
        totRev    += b.pl.revenue.subtotal || 0;
        totExp    += b.pl.expenses.total   || 0;
        totOrders += b.pl.revenue.orderCount || 0;
        Object.entries(b.pl.expenses.byCategory||{}).forEach(([cat,v]) => {
          agg.expenses.byCategory[cat] = agg.expenses.byCategory[cat] || { total:0 };
          agg.expenses.byCategory[cat].total += v.total||0;
        });
      });
      data = { period: { from, to }, revenue: { orderCount: totOrders, subtotal: totRev }, expenses: { byCategory: agg.expenses.byCategory, total: totExp }, summary: { netProfit: totRev-totExp, profitMargin: totRev>0?(((totRev-totExp)/totRev)*100).toFixed(1):'0.0', isProfit: totRev>=totExp } };
    } else {
      const res = await fetch(`/api/businesses/${branchSel}/accounting/pl?from=${from||''}&to=${to||''}`, { headers: { 'x-admin-token': token } });
      data = await res.json();
    }

    if (data.error) { if(body) body.innerHTML='<div style="color:#e57;padding:16px">'+data.error+'</div>'; return; }

    const pl = data;
    const profitColor = pl.summary.isProfit ? '#22c55e' : '#ef4444';
    const catRows = Object.entries(pl.expenses.byCategory||{}).map(([cat,v]) =>
      `<tr><td style="text-transform:capitalize;padding:6px 0">${cat}</td><td style="text-align:right;color:#666">${fmt(v.total)}</td></tr>`
    ).join('') || '<tr><td colspan="2" style="color:#bbb;padding:6px 0">No expenses recorded</td></tr>';

    if (body) body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <div style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#999;margin-bottom:10px">Revenue</div>
          <table style="width:100%;font-size:14px">
            <tr><td style="padding:6px 0">Orders (${pl.revenue.orderCount})</td><td style="text-align:right;font-weight:600">${fmt(pl.revenue.subtotal)}</td></tr>
            <tr><td style="padding:6px 0;color:#aaa">GST Collected</td><td style="text-align:right;color:#aaa">${fmt(pl.revenue.gstCollected)}</td></tr>
            <tr style="border-top:2px solid #eee"><td style="padding:8px 0;font-weight:700">Gross Revenue</td><td style="text-align:right;font-weight:700">${fmt(pl.revenue.grossRevenue)}</td></tr>
          </table>
          <div style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#999;margin:16px 0 10px">Expenses</div>
          <table style="width:100%;font-size:14px">${catRows}
            <tr style="border-top:2px solid #eee"><td style="padding:8px 0;font-weight:700">Total Expenses</td><td style="text-align:right;font-weight:700;color:#ef4444">${fmt(pl.expenses.total)}</td></tr>
          </table>
        </div>
        <div style="display:flex;flex-direction:column;justify-content:center;align-items:center;background:#fafafa;border-radius:12px;padding:24px;text-align:center">
          <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#999;margin-bottom:8px">Net ${pl.summary.isProfit?'Profit':'Loss'}</div>
          <div style="font-size:42px;font-weight:800;color:${profitColor};margin-bottom:4px">${fmt(Math.abs(pl.summary.netProfit))}</div>
          <div style="font-size:16px;font-weight:600;color:${profitColor}">${pl.summary.profitMargin}% margin</div>
          <div style="font-size:12px;color:#aaa;margin-top:8px">${pl.period.from} → ${pl.period.to}</div>
        </div>
      </div>`;
  } catch(e) { if(body) body.innerHTML='<div style="color:#e57;padding:16px">'+e.message+'</div>'; }
}

async function loadGST() {
  const token  = sessionStorage.getItem('admin_token');
  const branch = document.getElementById('gst-branch')?.value;
  const month  = document.getElementById('gst-month')?.value;
  const year   = document.getElementById('gst-year')?.value;
  const body   = document.getElementById('gst-body');
  if (!token)  { alert('Load billing data first'); return; }
  if (!branch) { alert('Select a branch'); return; }
  if (body) body.innerHTML = '<div style="color:#bbb;text-align:center;padding:20px">Loading...</div>';

  try {
    const data = await fetch(`/api/businesses/${branch}/accounting/gst?month=${month}&year=${year}`, { headers: { 'x-admin-token': token } }).then(r=>r.json());
    if (data.error) { if(body) body.innerHTML='<div style="color:#e57;padding:16px">'+data.error+'</div>'; return; }
    const g = data;
    const fmt = n => '₹' + (Math.round(n*100)/100).toLocaleString('en-IN');
    if (body) body.innerHTML = `
      <div style="max-width:560px">
        <div style="font-weight:700;font-size:15px;margin-bottom:16px">Filing Period: ${g.period.label}</div>
        <table style="width:100%;font-size:14px;border-collapse:collapse">
          <tr style="background:#f9f9f9"><td style="padding:10px;border:1px solid #eee;font-weight:600" colspan="2">Outward Supplies (Sales)</td></tr>
          <tr><td style="padding:8px 10px;border:1px solid #eee">Total Invoices</td><td style="padding:8px 10px;border:1px solid #eee;text-align:right">${g.outwardSupplies.invoiceCount}</td></tr>
          <tr><td style="padding:8px 10px;border:1px solid #eee">Taxable Value</td><td style="padding:8px 10px;border:1px solid #eee;text-align:right;font-weight:600">${fmt(g.outwardSupplies.taxableValue)}</td></tr>
          <tr><td style="padding:8px 10px;border:1px solid #eee">CGST (2.5%)</td><td style="padding:8px 10px;border:1px solid #eee;text-align:right">${fmt(g.outwardSupplies.cgst)}</td></tr>
          <tr><td style="padding:8px 10px;border:1px solid #eee">SGST (2.5%)</td><td style="padding:8px 10px;border:1px solid #eee;text-align:right">${fmt(g.outwardSupplies.sgst)}</td></tr>
          <tr style="background:#fff9e6"><td style="padding:8px 10px;border:1px solid #eee;font-weight:700">Total GST Collected</td><td style="padding:8px 10px;border:1px solid #eee;text-align:right;font-weight:700">${fmt(g.outwardSupplies.totalGst)}</td></tr>
          ${g.inputTaxCredit>0?`<tr><td style="padding:8px 10px;border:1px solid #eee;color:#22c55e">Input Tax Credit</td><td style="padding:8px 10px;border:1px solid #eee;text-align:right;color:#22c55e">- ${fmt(g.inputTaxCredit)}</td></tr>`:''}
          <tr style="background:#fef2f2"><td style="padding:10px;border:1px solid #eee;font-weight:700;font-size:15px">Net GST Payable</td><td style="padding:10px;border:1px solid #eee;text-align:right;font-weight:700;font-size:15px;color:#ef4444">${fmt(g.netGstPayable)}</td></tr>
        </table>
        <div style="margin-top:12px;font-size:12px;color:#aaa">* File via GST portal (gst.gov.in) under GSTR-1 for outward supplies</div>
      </div>`;
  } catch(e) { if(body) body.innerHTML='<div style="color:#e57;padding:16px">'+e.message+'</div>'; }
}
