# ☕ Café Command HQ: Multi-Tenant AI Bot & CRM Platform

An enterprise-grade SaaS Platform designed for restaurant owners to centrally manage multiple café locations, deploy auto-responding AI agents (supporting English, Hindi, and Hinglish), analyze weekly customer traffic to spot slow days, and dynamically broadcast marketing campaigns to boost reservation crowds.

---

## 🌟 Key Features

1. **Super Admin SaaS Dashboard (HQ Overview)**:
   - Dynamic aggregated KPIs tracking Total linked businesses, Combined bookings, and Live bots.
   - Comparative multi-branch performance metrics visualizing reservation statistics.
   - **Consolidated Traffic Heatmap**: Monitors hourly customer inquiries (Sunday - Saturday) to pinpoint low-traffic intervals.

2. **Multi-Tenant Franchise Registry**:
   - Easily register new franchise locations with dedicated brand parameters (Address, Timings, WiFi, Contact, Maps).
   - Dynamic file-isolation per branch (Menu, CRM ledger, Traffic databases, Campaigns).

3. **Real WhatsApp Linking (`whatsapp-web.js`)**:
   - Uses Puppeteer and headless browser automation to run automated agents on actual phone lines.
   - Links easily via a **dynamic QR Code displayed directly on the local web dashboard** (WhatsApp -> Linked Devices -> Link a Device).

4. **Multi-Tenant Chat Simulator**:
   - Provides a built-in testing interface allowing you to simulate and chat with the AI for *any* franchise branch instantly.
   - Tests automatic language detection (English/Hindi/Hinglish) and multi-turn reservation flow seamlessly.

5. **Dynamic Pricing & "Sasta" Reasoning Engine**:
   - The AI dynamically reads the active `menu.json` prices and discounts configured on the dashboard.
   - Accurately performs item calculations, quotes active discounts (e.g. *"Our Classic Burger is ₹179, but with today's 20% discount, it is just ₹143!"*), and dynamically sorts and recommends budget items if the customer asks *"sasta kya hai?"*.

6. **Smart Marketing & Crowding Assistant**:
   - Identifies slow days automatically and encourages scheduling promotional schemes.
   - Proactively pitches localized specials (e.g. Tuesday Free Cookies) when customers enquire on those specific days!
   - Select customer cohorts based on intent tags (e.g., "Frequent Coffee Drinkers") and broadcast custom WhatsApp promotions.

---

## 🚀 How to Run Locally

### 1. Initialize Codebase
Move into the directory and install dependencies:
```bash
npm install
```

### 2. Launch Server
Start the Express + Socket.io + Puppeteer background script:
```bash
npm start
```
This runs the local headquarters on **`http://localhost:3080`**.

### 3. Open Web Dashboard & Scan QR
1. Open your browser and go to `http://localhost:3080`.
2. Navigate to **Manage Franchises** -> Click **Manage Branch** for any café.
3. Click **🔌 Connect WhatsApp Line**. Wait a few seconds for the headless browser to spawn and display the QR Code.
4. Open WhatsApp on your phone -> Settings -> Linked Devices -> **Link a Device** and scan the QR on the screen!

### 4. Interactive Simulation Testing
To play with the bot immediately without linking a phone:
1. Ensure **Simulator Mode** is toggled ON at the top right of the Chat Widget.
2. Click any of the **Quick Presets** (e.g., "Menu", "Book Table", "Sasta kya hai?", or "Complaint") or type a custom query.
3. The AI Bot will analyze the branch's active settings, parse your language, and reply dynamically in 1.2 seconds!
