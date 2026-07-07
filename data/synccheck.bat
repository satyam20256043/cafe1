@echo off
cd /d C:\Users\pc\.claude\sessions\cafe-ai-bot\data
(
echo ===server.js===
node --check server.js
echo ----DONE----
echo ===routes\agency.js===
node --check routes\agency.js
echo ----DONE----
echo ===routes\loyalty.js===
node --check routes\loyalty.js
echo ----DONE----
echo ===routes\orders.js===
node --check routes\orders.js
echo ----DONE----
echo ===routes\extras.js===
node --check routes\extras.js
echo ----DONE----
echo ===routes\business.js===
node --check routes\business.js
echo ----DONE----
echo ===routes\marketing.js===
node --check routes\marketing.js
echo ----DONE----
echo ===routes\activity.js===
node --check routes\activity.js
echo ----DONE----
echo ===routes\feedback.js===
node --check routes\feedback.js
echo ----DONE----
echo ===routes\auth.js===
node --check routes\auth.js
echo ----DONE----
echo ===routes\billing.js===
node --check routes\billing.js
echo ----DONE----
) > synccheck.txt 2>&1
echo ALLDONE
