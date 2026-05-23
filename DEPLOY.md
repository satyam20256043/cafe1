# Deploying Café SaaS HQ to Railway

## Files to upload to your project folder
Make sure these files are all together:
- server.js (updated)
- package.json
- package-lock.json
- Dockerfile
- .gitignore
- .dockerignore
- public/ folder (your dashboard HTML/CSS/JS)

---

## Step 1 — Push to GitHub

1. Create a new repo at github.com (e.g. `cafe-saas-hq`)
2. Open terminal in your project folder and run:

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/cafe-saas-hq.git
git push -u origin main
```

---

## Step 2 — Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `cafe-saas-hq` repo
4. Railway will auto-detect the **Dockerfile** and build it

---

## Step 3 — Add a Volume (for WhatsApp session persistence)

Without this, you'll need to re-scan the QR code every time Railway restarts.

1. In your Railway project, click **"+ Add"** → **"Volume"**
2. Mount path: `/app/.wwebjs_auth`
3. This saves your WhatsApp session permanently

---

## Step 4 — Get your public URL

1. In Railway → your service → **"Settings"** → **"Networking"**
2. Click **"Generate Domain"**
3. Your app will be live at `https://your-app.up.railway.app`

---

## Step 5 — Scan QR Code

1. Open `https://your-app.up.railway.app` in your browser
2. Go to the WhatsApp section on the dashboard
3. Scan the QR code with the café's WhatsApp number
4. Bot is now live!

---

## Important Notes

- **Free tier**: Railway gives $5/month free credit. The bot + Chromium will use it within ~2-3 weeks.
- **Session**: Once you scan QR and the Volume is attached, the session persists across restarts.
- **Logs**: Railway → your service → "Logs" tab to debug any issues.
