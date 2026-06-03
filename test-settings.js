const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  
  // Handle the confirm dialog when deleting a station
  page.on('dialog', async dialog => {
    console.log("Dialog opened:", dialog.message());
    await dialog.accept();
  });

  console.log("Navigating to Dashboard...");
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });

  // 1. Open Settings
  console.log("Opening Settings...");
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const settingsBtn = btns.find(b => b.innerText.includes('Einstellungen'));
    if (settingsBtn) settingsBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  // 2. Open Stations tab
  console.log("Navigating to Stations tab...");
  await page.evaluate(() => {
    const navs = Array.from(document.querySelectorAll('.settings-nav-item'));
    const stNav = navs.find(n => n.innerText.includes('Messstellen'));
    if (stNav) stNav.click();
  });
  await new Promise(r => setTimeout(r, 500));

  // 3. Click Add Station
  console.log("Clicking 'Messstelle hinzufügen'...");
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const addBtn = btns.find(b => b.innerText.includes('Messstelle hinzufügen'));
    if (addBtn) addBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  // 4. Fill form
  console.log("Filling form for new station (test-station)...");
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('.card input[type="text"]');
    if (inputs.length >= 3) {
      // simulate React input change by setting value and dispatching event
      const setReactValue = (el, val) => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setReactValue(inputs[0], 'test_station_99');
      setReactValue(inputs[1], 'Test Puppeteer');
      setReactValue(inputs[2], 'Automated Test Location');
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // 5. Save
  console.log("Saving new station...");
  await page.screenshot({ path: '/tmp/test-before-save.png' });
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.dialog button, .card button'));
    const saveBtn = btns.find(b => b.innerText.includes('Speichern'));
    if (saveBtn) saveBtn.click();
  });
  
  // Wait for the async API refresh (forceApiRefresh) to finish
  console.log("Waiting 2s for API refresh...");
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/tmp/test-after-save.png' });

  // 6. Verify station is in the DOM
  const tableText = await page.evaluate(() => {
    const table = document.querySelector('.settings-table');
    return table ? table.innerText : '';
  });
  if (tableText.includes('Test Puppeteer')) {
    console.log("SUCCESS: Station was added and appears in the list instantly!");
  } else {
    console.error("FAIL: Station 'Test Puppeteer' not found in the list. UI might not have re-rendered.");
    await browser.close();
    process.exit(1);
  }

  // 7. Delete station
  console.log("Clicking delete on new station...");
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.settings-table tbody tr'));
    const testRow = rows.find(r => r.innerText.includes('Test Puppeteer'));
    if (testRow) {
      const delBtn = testRow.querySelector('button[title="Löschen"]');
      if (delBtn) delBtn.click();
    }
  });

  console.log("Waiting 1s for API refresh...");
  await new Promise(r => setTimeout(r, 1000));

  // 8. Verify deletion
  const newTableText = await page.evaluate(() => {
    const table = document.querySelector('.settings-table');
    return table ? table.innerText : '';
  });
  if (!newTableText.includes('Test Puppeteer')) {
    console.log("SUCCESS: Station was deleted and disappeared from the list instantly!");
  } else {
    console.error("FAIL: Station 'Test Puppeteer' still in the list after deletion.");
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  console.log("Test finished successfully.");
})();
