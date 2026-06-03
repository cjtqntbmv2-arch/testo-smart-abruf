const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Navigate to Dashboard
  console.log('Navigating to dashboard...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  
  // Wait for React to render tiles
  await page.waitForSelector('.metric-card', { timeout: 5000 }).catch(() => console.log('Timeout waiting for metric-card'));
  
  // Check the data that is loaded in window.DASH_DATA
  const data = await page.evaluate(() => {
    return {
      stations: Object.keys(window.DASH_DATA.stations).reduce((acc, k) => {
        const s = window.DASH_DATA.stations[k];
        acc[k] = {
          metrics: Object.keys(s.metrics).reduce((macc, mk) => {
             macc[mk] = s.metrics[mk].series;
             return macc;
          }, {})
        };
        return acc;
      }, {})
    };
  });
  
  console.log(JSON.stringify(data, null, 2));
  
  await browser.close();
})();
