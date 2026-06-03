const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    headless: "new"
  });
  const page = await browser.newPage();
  
  console.log("Navigating to http://localhost:3000...");
  
  page.on('response', async (response) => {
    if (response.url().includes('/api/')) {
      console.log(`API Response from ${response.url()}: ${response.status()}`);
      try {
        const text = await response.text();
        console.log(`Body: ${text.substring(0, 100)}...`);
      } catch (e) {}
    }
  });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });

  // Wait for React to render and for API fetch to finish
  // The app fetches every 5s. Give it 2s to fetch initial data.
  await new Promise(r => setTimeout(r, 4000));

  console.log("Extracting visible text to verify real data...");
  const dataTexts = await page.evaluate(() => {
    // Collect text from .num, .legend-val, .srow-v
    const els = document.querySelectorAll('.num, .legend-val, .srow-v');
    return Array.from(els).map(e => e.innerText).filter(t => t.trim().length > 0);
  });
  console.log("UI Texts:", dataTexts);

  // Take a full accessibility tree snapshot
  const client = await page.target().createCDPSession();
  const { nodes } = await client.send('Accessibility.getFullAXTree');
  
  // Basic check of the tree
  console.log(`Accessibility tree has ${nodes.length} nodes.`);
  // Look for any elements without names that should have them
  const buttons = nodes.filter(n => n.role && n.role.value === 'button');
  const emptyButtons = buttons.filter(b => !b.name || !b.name.value);
  
  console.log(`Found ${buttons.length} buttons.`);
  if (emptyButtons.length > 0) {
    console.log(`WARNING: ${emptyButtons.length} buttons have no accessible name.`);
  }

  // Save screenshot
  await page.screenshot({ path: '/tmp/dashboard-screenshot.png', fullPage: true });
  console.log("Screenshot saved to /tmp/dashboard-screenshot.png");

  await browser.close();
})().catch(e => {
  console.error("Puppeteer error:", e);
  process.exit(1);
});
