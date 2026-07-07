const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("No API key found in .env!");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

async function testModel(modelName) {
  console.log(`Testing model: ${modelName}...`);
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent("Say hello!");
    console.log(`[SUCCESS] ${modelName} responded: ${result.response.text().trim()}`);
    return true;
  } catch (err) {
    console.error(`[FAILED] ${modelName}:`, err.message);
    return false;
  }
}

async function run() {
  await testModel("gemini-2.0-flash-lite");
  await testModel("gemini-1.5-flash");
}

run();
