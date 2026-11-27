/**
 * NULPLF API: the Google Apps Script backend for the NULPLF lost-and-found page.
 *
 * The Google Sheet is the database:
 *   Items tab    found items. Public: every student's page pulls these.
 *                Staff can also type a row here by hand; the API fills in the ID and tag.
 *   Claims tab   claim requests with the claimant's details. Only staff can read these,
 *                and the details are deleted 30 days after a claim is closed.
 *   Reports tab  lost-item reports from students who want an email when a possible match
 *                is posted. Deleted after 30 days, or when the student stops alerts.
 *
 * Emails (sent from the Google account that owns this sheet):
 *   staff     get one for every new claim (NULPLF > Set alert email to change the address)
 *   students  get the result of their claim, and match alerts for their lost-item reports
 *
 * Setup (once), see SETUP.md:
 *   1. In the Google Sheet: Extensions > Apps Script. Replace everything with this file. Save.
 *   2. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *   3. Reload the sheet and use NULPLF > Set staff login.
 * After changing this file: Deploy > Manage deployments > Edit > Version: New version > Deploy.
 */

const SITE_URL = "https://nulplf.netlify.app";  // the website, linked in emails
const OFFICE_INFO = "the Security Office (ground floor, near the main gate), Monday to Saturday, 7:00 AM to 8:00 PM";
const TZ = "Asia/Manila";
const KEEP_DAYS = 30;                    // claimant details and lost-item reports are deleted after this many days
const SESSION_SECONDS = 6 * 60 * 60;     // staff stay logged in up to 6 hours (the CacheService maximum)
const MAX_PENDING_PER_STUDENT = 3;
const MAX_REPORTS_PER_DAY = 5;
const ITEM_COLS = ["id", "tag", "name", "cat", "place", "date", "desc", "status", "photoId", "blurred", "postedAt", "releasedAt"];
const CLAIM_COLS = ["cid", "itemId", "itemName", "tag", "name", "studentNo", "contact", "proof", "consent", "status", "at", "decidedAt", "purged"];
const REPORT_COLS = ["rid", "name", "email", "cat", "date", "item", "place", "at", "notified"];
const CATS = ["ID", "Umbrella", "Charger", "Tumbler", "Calculator", "Flash drive", "Notebook", "Earphones", "Bag", "Wallet", "Other"];
const PLACES = ["Main lobby", "Library", "Canteen", "Gym", "Computer labs", "Classrooms, 2nd floor", "Classrooms, 3rd floor", "Classrooms, 4th floor", "Comfort rooms", "Parking area", "Other"];

/* ===================== Sheet menu and one-time setup ===================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu("NULPLF")
    .addItem("Set up sheets", "setup")
    .addItem("Set staff login", "setStaffLogin")
    .addItem("Set alert email", "setAlertEmail")
    .addToUi();
}

function setup() {
  autoSetup_();
  photoFolder_();
  tell_("The Items, Claims and Reports tabs are ready. Next: NULPLF > Set staff login.");
}

// Also runs by itself the first time the website calls the API, so the menu step is optional.
function autoSetup_() {
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName("Items")) prepareSheet_(ss, "Items", ITEM_COLS);
  if (!ss.getSheetByName("Claims")) prepareSheet_(ss, "Claims", CLAIM_COLS);
  if (!ss.getSheetByName("Reports")) prepareSheet_(ss, "Reports", REPORT_COLS);
  try {
    if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === "purgeOldClaims")) {
      ScriptApp.newTrigger("purgeOldClaims").timeBased().everyDays(1).atHour(2).inTimezone(TZ).create();
    }
  } catch (e) { /* staff opening the claims list also runs the clean-up */ }
}

function prepareSheet_(ss, name, cols) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight("bold");
  sh.setFrozenRows(1);
  sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), cols.length).setNumberFormat("@"); // keep dates and numbers as typed
}

function setStaffLogin() {
  const ui = SpreadsheetApp.getUi();
  const u = ui.prompt("Staff username", "What staff type to log in, for example: admin", ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  const user = u.getResponseText().trim().toLowerCase();
  if (!user) { ui.alert("The username can't be empty."); return; }
  const p = ui.prompt("Staff password", "At least 8 characters. Share it only with Security Office staff.", ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  const pass = p.getResponseText();
  if (pass.length < 8) { ui.alert("Use at least 8 characters."); return; }
  const salt = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({ STAFF_USER: user, STAFF_SALT: salt, STAFF_HASH: hash_(salt + pass) });
  ui.alert("Staff login saved. The password is stored only as a hash, never as plain text.");
}

function setAlertEmail() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt("Email for new-claim alerts", "Staff get an email here whenever a student sends a claim.\nNow: " + (alertEmail_() || "none"), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const v = r.getResponseText().trim();
  if (!isEmail_(v)) { ui.alert("That doesn't look like an email address."); return; }
  PropertiesService.getScriptProperties().setProperty("ALERT_EMAIL", v);
  ui.alert("New-claim alerts will go to " + v + ".");
}

function tell_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("PHOTO_FOLDER");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* folder was deleted: make a new one */ } }
  const folder = DriveApp.createFolder("NULPLF photos");
  props.setProperty("PHOTO_FOLDER", folder.getId());
  return folder;
}

/* ===================== Web app: the API ===================== */

// GET ?action=items  ->  { ok, items: [...] }   (public)
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "items";
    if (action === "items") return out_({ ok: true, items: listItems_(), now: new Date().toISOString() });
    return out_({ ok: false, error: "unknown_action" });
  } catch (err) {
    return out_({ ok: false, error: "server_error", message: String((err && err.message) || err) });
  }
}

// POST { action: "claim" | "status" | "report" | "unreport" | "login" | "staff", ... }
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "bad_request" }); }
  try {
    if (req.action === "claim") return out_(claim_(req));
    if (req.action === "status") return out_(statuses_(req));
    if (req.action === "report") return out_(report_(req));
    if (req.action === "unreport") return out_(unreport_(req));
    if (req.action === "login") return out_(login_(req));
    if (req.action === "staff") return out_(staff_(req));
    return out_({ ok: false, error: "unknown_action" });
  } catch (err) {
    return out_({ ok: false, error: "server_error", message: String((err && err.message) || err) });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ----- public: found items ----- */

function listItems_() {
  let rows = rows_("Items", ITEM_COLS).filter(r => str_(r.name));
  const added = [];
  if (rows.some(r => !str_(r.id) || !str_(r.tag))) {
    // A staff member typed a row by hand: give it an ID and a tag number.
    withLock_(() => {
      rows = rows_("Items", ITEM_COLS).filter(r => str_(r.name));
      let next = nextTagNo_(rows);
      rows.forEach(r => {
        if (str_(r.id) && str_(r.tag)) return;
        if (!str_(r.id)) r.id = newId_("i");
        if (!str_(r.tag)) r.tag = tag_(next++);
        if (!str_(r.postedAt)) r.postedAt = new Date().toISOString();
        r.date = day_(r.date); r.status = status_(r.status); r.cat = pick_(r.cat, CATS); r.place = pick_(r.place, PLACES);
        save_("Items", ITEM_COLS, r);
        added.push(r);
      });
    });
  }
  added.forEach(notifyMatches_);
  return rows.map(publicItem_);
}

function publicItem_(r) {
  return {
    id: str_(r.id, 40), tag: str_(r.tag, 20), name: str_(r.name, 120),
    cat: pick_(r.cat, CATS), place: pick_(r.place, PLACES), date: day_(r.date),
    desc: str_(r.desc, 500), status: status_(r.status),
    photoId: str_(r.photoId, 100), blurred: bool_(r.blurred), releasedAt: iso_(r.releasedAt)
  };
}

/* ----- public: claims ----- */

// Several students can claim the same item; staff compare the answers and approve one.
function claim_(req) {
  const name = str_(req.name, 80), no = str_(req.studentNo, 20), contact = str_(req.contact, 120), proof = str_(req.proof, 1000);
  if (req.consent !== true) return { ok: false, error: "no_consent" };
  if (name.length < 2 || !/^\d{4}-\d{4,8}$/.test(no) || contact.length < 3 || proof.length < 3) return { ok: false, error: "missing_fields" };
  const res = withLock_(() => {
    const it = findItem_(req.itemId);
    if (!it) return { ok: false, error: "not_found" };
    if (status_(it.status) === "claimed") return { ok: false, error: "not_available" };
    const claims = rows_("Claims", CLAIM_COLS);
    const mine = claims.filter(c => str_(c.studentNo) === no && cstatus_(c.status) === "pending");
    if (mine.some(c => str_(c.itemId) === str_(it.id))) return { ok: false, error: "already_claimed" };
    if (mine.length >= MAX_PENDING_PER_STUDENT) return { ok: false, error: "too_many" };
    const claim = {
      cid: "CL-" + Utilities.getUuid().replace(/-/g, "").slice(0, 8).toUpperCase(),
      itemId: str_(it.id), itemName: str_(it.name), tag: str_(it.tag),
      name, studentNo: no, contact, proof, consent: true,
      status: "pending", at: new Date().toISOString(), decidedAt: "", purged: false
    };
    add_("Claims", CLAIM_COLS, claim);
    if (status_(it.status) !== "pending") { it.status = "pending"; save_("Items", ITEM_COLS, it); }
    const open = claims.filter(c => str_(c.itemId) === str_(it.id) && cstatus_(c.status) === "pending").length + 1;
    return { ok: true, claim, open };
  });
  if (!res.ok) return res;
  notifyStaffNewClaim_(res.claim, res.open);
  return { ok: true, cid: res.claim.cid };
}

// Students know only their own claim references, and get back only the status: no personal details.
function statuses_(req) {
  const want = (Array.isArray(req.cids) ? req.cids : []).slice(0, 50).map(c => str_(c, 20));
  const out = {};
  rows_("Claims", CLAIM_COLS).forEach(c => {
    const id = str_(c.cid);
    if (id && want.indexOf(id) >= 0) out[id] = { status: cstatus_(c.status), decidedAt: iso_(c.decidedAt), purged: bool_(c.purged) };
  });
  return { ok: true, statuses: out };
}

/* ----- public: lost-item reports for match alerts ----- */

function report_(req) {
  const name = str_(req.name, 80), email = str_(req.email, 120), item = str_(req.item, 120);
  if (req.consent !== true) return { ok: false, error: "no_consent" };
  if (name.length < 2 || !isEmail_(email) || !item) return { ok: false, error: "missing_fields" };
  return withLock_(() => {
    const dayAgo = Date.now() - 864e5;
    const recent = rows_("Reports", REPORT_COLS).filter(r => str_(r.email).toLowerCase() === email.toLowerCase() && Date.parse(iso_(r.at)) > dayAgo).length;
    if (recent >= MAX_REPORTS_PER_DAY) return { ok: false, error: "too_many" };
    const rid = "LR-" + Utilities.getUuid().replace(/-/g, "").slice(0, 12).toUpperCase();
    add_("Reports", REPORT_COLS, {
      rid, name, email, cat: pick_(req.cat, CATS), date: day_(req.date), item,
      place: str_(req.place) ? pick_(req.place, PLACES) : "", at: new Date().toISOString(), notified: ""
    });
    return { ok: true, rid };
  });
}

// "Stop alerts": deletes the report from the sheet.
function unreport_(req) {
  const rid = str_(req.rid, 20);
  if (!rid) return { ok: false, error: "bad_request" };
  return withLock_(() => {
    const r = rows_("Reports", REPORT_COLS).filter(x => str_(x.rid) === rid)[0];
    if (r) sheet_("Reports").deleteRow(r._row);
    return { ok: true };
  });
}

/* ----- staff login: the password is checked here, on Google's server ----- */

function login_(req) {
  const props = PropertiesService.getScriptProperties();
  const hash = props.getProperty("STAFF_HASH");
  if (!hash) return { ok: false, error: "no_password_set" };
  const user = str_(req.user, 60).toLowerCase(), pass = String(req.password || "");
  if (user !== (props.getProperty("STAFF_USER") || "admin") || hash_(props.getProperty("STAFF_SALT") + pass) !== hash) {
    Utilities.sleep(1500); // slows down password guessing
    return { ok: false, error: "wrong_login" };
  }
  const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  CacheService.getScriptCache().put("staff:" + token, "1", SESSION_SECONDS);
  return { ok: true, token, expiresIn: SESSION_SECONDS };
}

function staff_(req) {
  const cache = CacheService.getScriptCache(), key = "staff:" + str_(req.token, 100);
  if (!str_(req.token) || !cache.get(key)) return { ok: false, error: "login_expired" };
  cache.put(key, "1", SESSION_SECONDS); // each action keeps the session alive
  switch (req.op) {
    case "claims":
      purgeOldClaims();
      return {
        ok: true,
        claims: rows_("Claims", CLAIM_COLS).filter(c => str_(c.cid)).map(staffClaim_),
        sheetUrl: SpreadsheetApp.getActive().getUrl() // staff only: for the "Open Google Sheet" button
      };
    case "post": return postItem_(req);
    case "edit": return editItem_(req);
    case "decide": return decide_(req);
    case "release": return releaseItem_(req.itemId);
    case "remove": return removeItem_(req.itemId);
    case "logout": cache.remove(key); return { ok: true };
  }
  return { ok: false, error: "unknown_action" };
}

function staffClaim_(c) {
  const purged = bool_(c.purged);
  return {
    cid: str_(c.cid), itemId: str_(c.itemId), itemName: str_(c.itemName), tag: str_(c.tag),
    name: purged ? "" : str_(c.name), studentNo: purged ? "" : str_(c.studentNo),
    contact: purged ? "" : str_(c.contact), proof: purged ? "" : str_(c.proof, 1000),
    status: cstatus_(c.status), at: iso_(c.at), decidedAt: iso_(c.decidedAt), purged
  };
}

function savePhoto_(photo, name) {
  if (!photo || !photo.data) return null;
  const data = String(photo.data);
  if (data.length > 4000000) { const e = new Error("photo_too_big"); e.code = "photo_too_big"; throw e; }
  const file = photoFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(data), "image/jpeg", name.slice(0, 40) + ".jpg"));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); // so the page can show it
  return { id: file.getId(), blurred: photo.blurred === true };
}

function trashPhoto_(id) {
  if (str_(id)) { try { DriveApp.getFileById(str_(id)).setTrashed(true); } catch (e) { /* already gone */ } }
}

function postItem_(req) {
  const i = req.item || {}, name = str_(i.name, 120);
  if (!name) return { ok: false, error: "missing_fields" };
  let photo;
  try { photo = savePhoto_(req.photo, name); } catch (e) { return { ok: false, error: e.code || "server_error" }; }
  const it = withLock_(() => {
    const row = {
      id: newId_("i"), tag: tag_(nextTagNo_(rows_("Items", ITEM_COLS))), name,
      cat: pick_(i.cat, CATS), place: pick_(i.place, PLACES), date: day_(i.date), desc: str_(i.desc, 500),
      status: "available", photoId: photo ? photo.id : "", blurred: photo ? photo.blurred : false,
      postedAt: new Date().toISOString(), releasedAt: ""
    };
    add_("Items", ITEM_COLS, row);
    return row;
  });
  notifyMatches_(it);
  return { ok: true, item: publicItem_(it) };
}

function editItem_(req) {
  const i = req.item || {}, name = str_(i.name, 120);
  if (!name) return { ok: false, error: "missing_fields" };
  let photo;
  try { photo = savePhoto_(req.photo, name); } catch (e) { return { ok: false, error: e.code || "server_error" }; }
  const res = withLock_(() => {
    const it = findItem_(req.itemId);
    if (!it) return { ok: false, error: "not_found" };
    const oldPhoto = str_(it.photoId);
    it.name = name; it.cat = pick_(i.cat, CATS); it.place = pick_(i.place, PLACES); it.date = day_(i.date); it.desc = str_(i.desc, 500);
    let trash = "";
    if (photo) { it.photoId = photo.id; it.blurred = photo.blurred; trash = oldPhoto; }
    else if (req.removePhoto === true) { it.photoId = ""; it.blurred = false; trash = oldPhoto; }
    save_("Items", ITEM_COLS, it);
    return { ok: true, it, trash };
  });
  if (!res.ok) { if (photo) trashPhoto_(photo.id); return res; }
  trashPhoto_(res.trash);
  notifyMatches_(res.it);
  return { ok: true, item: publicItem_(res.it) };
}

// Approving one claim closes the other open claims for the same item.
function decide_(req) {
  const status = req.status === "approved" ? "approved" : req.status === "rejected" ? "rejected" : "";
  if (!status) return { ok: false, error: "bad_request" };
  const res = withLock_(() => {
    const c = rows_("Claims", CLAIM_COLS).filter(x => str_(x.cid) === str_(req.cid, 20))[0];
    if (!c) return { ok: false, error: "not_found" };
    if (cstatus_(c.status) !== "pending") return { ok: false, error: "already_closed" };
    const now = new Date().toISOString();
    c.status = status; c.decidedAt = now;
    save_("Claims", CLAIM_COLS, c);
    const it = findItem_(c.itemId);
    let closed = [];
    if (status === "approved") {
      closed = closePending_(str_(c.itemId), now);
      if (it) { it.status = "claimed"; it.releasedAt = now; save_("Items", ITEM_COLS, it); }
    } else if (it && status_(it.status) !== "claimed") {
      const left = rows_("Claims", CLAIM_COLS).filter(x => str_(x.itemId) === str_(c.itemId) && cstatus_(x.status) === "pending").length;
      it.status = left ? "pending" : "available";
      save_("Items", ITEM_COLS, it);
    }
    return { ok: true, decided: c, closed };
  });
  if (!res.ok) return res;
  notifyClaimant_(res.decided, status);
  res.closed.forEach(x => notifyClaimant_(x, "rejected"));
  return { ok: true };
}

// "Mark claimed": the owner picked it up at the office. Open online claims for it are closed.
function releaseItem_(id) {
  const res = withLock_(() => {
    const it = findItem_(id);
    if (!it) return { ok: false, error: "not_found" };
    const now = new Date().toISOString();
    it.status = "claimed"; it.releasedAt = now;
    save_("Items", ITEM_COLS, it);
    return { ok: true, closed: closePending_(str_(it.id), now) };
  });
  if (!res.ok) return res;
  res.closed.forEach(x => notifyClaimant_(x, "rejected"));
  return { ok: true };
}

function removeItem_(id) {
  const res = withLock_(() => {
    const it = findItem_(id);
    if (!it) return { ok: false, error: "not_found" };
    sheet_("Items").deleteRow(it._row);
    return { ok: true, photo: str_(it.photoId), closed: closePending_(str_(it.id), new Date().toISOString()) };
  });
  if (!res.ok) return res;
  trashPhoto_(res.photo);
  res.closed.forEach(x => notifyClaimant_(x, "rejected"));
  return { ok: true };
}

// Closes every open claim for an item. Call inside withLock_.
function closePending_(itemId, now) {
  return rows_("Claims", CLAIM_COLS)
    .filter(c => str_(c.itemId) === itemId && cstatus_(c.status) === "pending")
    .map(c => { c.status = "rejected"; c.decidedAt = now; save_("Claims", CLAIM_COLS, c); return c; });
}

/* Runs daily (set up automatically) and whenever staff open the claims list. */
function purgeOldClaims() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    rows_("Claims", CLAIM_COLS).forEach(c => {
      const decided = Date.parse(iso_(c.decidedAt));
      if (!bool_(c.purged) && decided && decided <= cutoff) {
        c.name = ""; c.studentNo = ""; c.contact = ""; c.proof = ""; c.purged = true;
        save_("Claims", CLAIM_COLS, c);
      }
    });
    rows_("Reports", REPORT_COLS).reverse().forEach(r => {   // bottom-up so row numbers stay right
      const at = Date.parse(iso_(r.at));
      if (str_(r.rid) && at && at <= cutoff) sheet_("Reports").deleteRow(r._row);
    });
  } finally { lock.releaseLock(); }
}

/* ===================== Emails ===================== */

function notifyStaffNewClaim_(c, open) {
  send_(alertEmail_(), "New claim: " + str_(c.itemName) + " (" + str_(c.tag) + ")",
    str_(c.name) + " sent a claim for " + str_(c.itemName) + " (" + str_(c.tag) + ")." +
    (open > 1 ? "\nThis item now has " + open + " claims to compare." : "") +
    "\n\nLog in to the Staff panel to approve or reject it:\n" + SITE_URL + "\n\nNULPLF Lost and Found");
}

function notifyClaimant_(c, status) {
  const to = str_(c.contact, 120);
  if (!isEmail_(to)) return;
  const item = str_(c.itemName) + " (" + str_(c.tag) + ")";
  if (status === "approved") {
    send_(to, "Approved: pick up your " + str_(c.itemName),
      "Hi " + first_(c.name) + ",\n\nGood news: your claim for " + item + " was approved.\n\n" +
      "Pick it up at " + OFFICE_INFO + ". Bring your NU ID and your claim reference " + str_(c.cid) + ".\n\n" +
      SITE_URL + "\n\nNULPLF Lost and Found");
  } else {
    send_(to, "Update on your claim for " + str_(c.itemName),
      "Hi " + first_(c.name) + ",\n\nYour claim for " + item + " wasn't approved.\n\n" +
      "If you think this is a mistake, visit " + OFFICE_INFO + " and mention reference " + str_(c.cid) + ".\n\n" +
      SITE_URL + "\n\nNULPLF Lost and Found");
  }
}

// Emails students whose lost-item report matches a newly posted item (same category, lost on or before the found date).
function notifyMatches_(it) {
  if (!it || status_(it.status) === "claimed") return;
  const id = str_(it.id), cat = pick_(it.cat, CATS), found = day_(it.date);
  const toSend = withLock_(() => {
    const out = [];
    rows_("Reports", REPORT_COLS).forEach(r => {
      if (!str_(r.rid) || pick_(r.cat, CATS) !== cat || day_(r.date) > found) return;
      const done = str_(r.notified, 2000).split(",").filter(Boolean);
      if (done.indexOf(id) >= 0) return;
      done.push(id);
      r.notified = done.slice(-30).join(",");
      save_("Reports", REPORT_COLS, r);
      out.push({ to: str_(r.email), name: str_(r.name), lost: str_(r.item), lostOn: day_(r.date) });
    });
    return out;
  });
  toSend.slice(0, 50).forEach(m => send_(m.to, "Possible match for your " + m.lost,
    "Hi " + first_(m.name) + ",\n\nThe Security Office just posted an item that may be yours:\n\n" +
    "  " + str_(it.name) + " (" + str_(it.tag) + ")\n  Found at " + pick_(it.place, PLACES) + " on " + found + "\n\n" +
    "If it's yours, open the site and click \"This is mine\":\n" + SITE_URL + "/#item-" + id + "\n\n" +
    "You're getting this because you reported a lost " + m.lost + " (" + m.lostOn + "). " +
    "To stop these emails, open My requests on the site and click Stop alerts.\n\nNULPLF Lost and Found"));
}

function send_(to, subject, body) {
  if (!isEmail_(to)) return false;
  try {
    if (MailApp.getRemainingDailyQuota() < 1) return false;
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: "NULPLF Lost and Found" });
    return true;
  } catch (e) { return false; } // an email problem never blocks the action itself
}

function alertEmail_() {
  const set = PropertiesService.getScriptProperties().getProperty("ALERT_EMAIL");
  if (set) return set;
  try { return Session.getEffectiveUser().getEmail(); } catch (e) { return ""; }
}

/* ===================== Helpers ===================== */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) { autoSetup_(); sh = ss.getSheetByName(name); }
  if (!sh) throw new Error("Open the Google Sheet and run NULPLF > Set up sheets.");
  return sh;
}

function rows_(name, cols) {
  const sh = sheet_(name), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = r[j]; });
    return o;
  });
}

function findItem_(id) {
  const want = str_(id, 40);
  return want ? rows_("Items", ITEM_COLS).filter(r => str_(r.id) === want)[0] : undefined;
}

function save_(name, cols, o) {
  sheet_(name).getRange(o._row, 1, 1, cols.length).setValues([cols.map(c => cell_(o[c]))]);
}

function add_(name, cols, o) {
  const sh = sheet_(name), row = sh.getLastRow() + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  const range = sh.getRange(row, 1, 1, cols.length);
  range.setNumberFormat("@");
  range.setValues([cols.map(c => cell_(o[c]))]);
  o._row = row;
  return row;
}

function cell_(v) { return v === undefined || v === null ? "" : typeof v === "boolean" ? String(v) : v; }
function str_(v, max) { return String(v === undefined || v === null ? "" : v).trim().slice(0, max || 500); }
function bool_(v) { return v === true || String(v).toLowerCase() === "true"; }
function isEmail_(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str_(v, 200)); }
function first_(name) { return str_(name, 80).split(/\s+/)[0] || "there"; }
function hash_(s) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function newId_(p) { return p + Utilities.getUuid().replace(/-/g, "").slice(0, 12); }
function tag_(n) { return "LF-" + String(n).padStart(4, "0"); }
function nextTagNo_(rows) { return rows.reduce((m, r) => Math.max(m, parseInt(str_(r.tag).replace(/\D/g, ""), 10) || 0), 100) + 1; }
function today_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"); }

function iso_(v) {
  if (v instanceof Date) return v.toISOString();
  const s = str_(v, 40);
  return s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : "";
}

// Accepts 2026-11-27, 11/27/2026 or a real date cell; anything else becomes today.
function day_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  const s = str_(v, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
  return today_();
}

function status_(v) {
  const s = str_(v, 20).toLowerCase();
  if (s === "available" || s === "pending" || s === "claimed") return s;
  if (s === "claim pending") return "pending";
  if (s === "returned" || s === "released") return "claimed";
  return "available";
}

function cstatus_(v) {
  const s = str_(v, 20).toLowerCase();
  return s === "approved" || s === "rejected" ? s : "pending";
}

function pick_(v, list) {
  const s = str_(v, 60).toLowerCase();
  return list.filter(x => x.toLowerCase() === s)[0] || "Other";
}
