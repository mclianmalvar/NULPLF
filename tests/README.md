# Tests

Browser tests for the website, plus a simulated Google Apps Script server
(`gas-mock.js`) that runs the real `apps-script/Code.gs` with fake Sheets, Drive,
MailApp and cache. No Google account or internet is needed.

```bash
npm install --no-save playwright
npx playwright install chromium
node tests/api.test.js        # Sheet API: post, claim, approve, staff login, 30-day deletion
node tests/features.test.js   # edit items, claim cards with photo, several claims, emails, report alerts
node tests/extras.test.js     # kept-until dates, share links, camera button, pickup slips, reminders, email warnings, visits
node tests/demo.test.js       # demo mode (?demo), phone layout, Philippine-time dates
```

`api.test.js`, `features.test.js` and `extras.test.js` print PASS/FAIL per check and end with
`ALL PASSED`. `demo.test.js` prints what it sees at each step and `errors: []`.
