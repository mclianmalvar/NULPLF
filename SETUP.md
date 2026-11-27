# Connect NULPLF to a Google Sheet (free API)

The website pulls found items from a Google Sheet through a small Google Apps Script API.
The Security Office's data lives in the sheet; the page shows it to students.

Time: about 10 minutes. Use a personal Google account (Gmail). Some school accounts block
"Anyone" web apps or public photo links.

## 1. Make the sheet and paste the script

1. Open **sheets.new** and name the sheet `NULPLF Lost and Found`.
2. Click **Extensions → Apps Script**. At the top, rename **Untitled project** to `NULPLF API`.
3. Delete everything in `Code.gs`, paste the whole file `apps-script/Code.gs` from this repo,
   and click **Save** (the disk icon).

## 2. Publish the API

1. In Apps Script, click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. **Execute as: Me**. **Who has access: Anyone**. Click **Deploy**.
4. Google asks for permission: **Authorize access** → pick your account →
   "Google hasn't verified this app" → **Advanced** → **Go to NULPLF API (unsafe)** → **Allow**.
   This warning is normal for a script you wrote yourself. It asks for Sheets (store items),
   Drive (save photos) and triggers (the daily privacy clean-up).
5. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy.../exec`.

The Items and Claims tabs are created by themselves the first time the website loads.

## 3. Set the staff login

1. Go back to the sheet and reload it. A **NULPLF** menu appears next to Help.
2. Click **NULPLF → Set staff login**. Type a username (for example `admin`) and a password of
   at least 8 characters. The password is saved only as a hash.

## 4. Connect the website

In `index.html`, find this line near the top of the main script:

```js
const API_URL="";
```

Paste your link between the quotes, save, and push the change to GitHub.
(Or send the link to Claude and it will do this for you.)

With `API_URL` empty, the page runs in demo mode with sample items and the demo staff login
`admin` / `lostfound2026`. With the link set, only the login you made in step 3 works.

## Day to day

- **Staff** open the site, click **Staff login** at the bottom, then post items, approve claims
  and mark items claimed.
- Staff can also type a row straight into the **Items** tab: fill in `name`, `cat`, `place` and
  `date`, and leave `id` and `tag` empty. They're filled in the next time someone opens the site.
- **Posters:** in the Staff panel, click **Print QR poster** (or open `poster.html`) for an A4
  poster with a QR code to the site. Print it at 100% scale with background graphics on.
- The **Claims** tab holds students' names, student numbers and contact details. Share the sheet
  only with Security Office staff (Share → add their emails). Details are cleared automatically
  30 days after a claim is closed.
- Photos are saved in a Drive folder called **NULPLF photos**, shared view-only by link so the
  page can show them. IDs and wallets are blurred before they're uploaded.

## Emails

- Staff get an email for every new claim. It goes to the Google account that owns the sheet;
  to use another address, click **NULPLF → Set alert email** in the sheet.
- Students who sign in with an email address get the result of their claim, and an email when
  an item matching their lost-item report is posted. Students who give a mobile number don't
  get emails; they check **My requests** on the site.
- Emails are sent from the sheet owner's Google account, up to Google's daily limit for free
  accounts (about 100 a day).
- Lost-item reports for email alerts are kept in the **Reports** tab for 30 days, or until the
  student clicks **Stop alerts**.

## Changing the script later

After editing `Code.gs`: **Deploy → Manage deployments → pencil icon → Version: New version →
Deploy**. If Google asks for permission again (for example, to send email), click **Allow**.
The `/exec` link stays the same, so the website doesn't need changing.
