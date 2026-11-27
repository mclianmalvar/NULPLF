/**
 * NULPLF API: the Google Apps Script backend for the NULPLF lost-and-found page.
 *
 * The Google Sheet is the database:
 *   Items tab   found items. Public: every student's page pulls these.
 *               Staff can also type a row here by hand; the API fills in the ID and tag.
 *   Claims tab  claim requests with the claimant's details. Only staff can read these,
 *               and the details are deleted 30 days after a claim is closed.
 *
 * Setup (once), see SETUP.md for screenshots-free steps:
 *   1. In the Google Sheet: Extensions > Apps Script. Replace everything with this file. Save.
 *   2. Reload the sheet. Use the new NULPLF menu: "Set up sheets", then "Set staff login".
 *   3. In Apps Script: Deploy > New deployment > Web app.
 *      Execute as: Me. Who has access: Anyone. Copy the web app URL (it ends in /exec).
 *   4. Put that URL in API_URL at the top of the script in index.html.
 */

const TZ = "Asia/Manila";
const KEEP_DAYS = 30;                    // claimant details are deleted this many days after a claim closes
const SESSION_SECONDS = 6 * 60 * 60;     // staff stay logged in up to 6 hours (the CacheService maximum)
const MAX_PENDING_PER_STUDENT = 3;
const ITEM_COLS = ["id", "tag", "name", "cat", "place", "date", "desc", "status", "photoId", "blurred", "postedAt", "releasedAt"];
const CLAIM_COLS = ["cid", "itemId", "itemName", "tag", "name", "studentNo", "contact", "proof", "consent", "status", "at", "decidedAt", "purged"];
const CATS = ["ID", "Umbrella", "Charger", "Tumbler", "Calculator", "Flash drive", "Notebook", "Earphones", "Bag", "Wallet", "Other"];
const PLACES = ["Main lobby", "Library", "Canteen", "Gym", "Computer labs", "Classrooms, 2nd floor", "Classrooms, 3rd floor", "Classrooms, 4th floor", "Comfort rooms", "Parking area", "Other"];

/* ===================== Sheet menu and one-time setup ===================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu("NULPLF")
    .addItem("Set up sheets", "setup")
    .addItem("Set staff login", "setStaffLogin")
    .addToUi();
}

function setup() {
  autoSetup_();
  photoFolder_();
  tell_("The Items and Claims tabs are ready. Next: NULPLF > Set staff login.");
}

// Also runs by itself the first time the website calls the API, so the menu step is optional.
function autoSetup_() {
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName("Items")) prepareSheet_(ss, "Items", ITEM_COLS);
  if (!ss.getSheetByName("Claims")) prepareSheet_(ss, "Claims", CLAIM_COLS);
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

// POST { action: "claim" | "status" | "login" | "staff", ... }
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "bad_request" }); }
  try {
    if (req.action === "claim") return out_(claim_(req));
    if (req.action === "status") return out_(statuses_(req));
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
      });
    });
  }
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

/* ----- public: send a claim, check claim status ----- */

function claim_(req) {
  const name = str_(req.name, 80), no = str_(req.studentNo, 20), contact = str_(req.contact, 120), proof = str_(req.proof, 1000);
  if (req.consent !== true) return { ok: false, error: "no_consent" };
  if (name.length < 2 || !/^\d{4}-\d{4,8}$/.test(no) || contact.length < 3 || proof.length < 3) return { ok: false, error: "missing_fields" };
  return withLock_(() => {
    const it = rows_("Items", ITEM_COLS).filter(r => str_(r.id) && str_(r.id) === str_(req.itemId, 40))[0];
    if (!it) return { ok: false, error: "not_found" };
    if (status_(it.status) !== "available") return { ok: false, error: "not_available" };
    const pending = rows_("Claims", CLAIM_COLS).filter(c => str_(c.studentNo) === no && cstatus_(c.status) === "pending").length;
    if (pending >= MAX_PENDING_PER_STUDENT) return { ok: false, error: "too_many" };
    const cid = "CL-" + Utilities.getUuid().replace(/-/g, "").slice(0, 8).toUpperCase();
    add_("Claims", CLAIM_COLS, {
      cid, itemId: str_(it.id), itemName: str_(it.name), tag: str_(it.tag),
      name, studentNo: no, contact, proof, consent: true,
      status: "pending", at: new Date().toISOString(), decidedAt: "", purged: false
    });
    it.status = "pending";
    save_("Items", ITEM_COLS, it);
    return { ok: true, cid };
  });
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
    case "decide": return decide_(req);
    case "release": return updateItem_(req.itemId, it => { it.status = "claimed"; it.releasedAt = new Date().toISOString(); });
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

function postItem_(req) {
  const i = req.item || {}, name = str_(i.name, 120);
  if (!name) return { ok: false, error: "missing_fields" };
  let photoId = "", blurred = false;
  if (req.photo && req.photo.data) {
    const data = String(req.photo.data);
    if (data.length > 4000000) return { ok: false, error: "photo_too_big" };
    const file = photoFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(data), "image/jpeg", name.slice(0, 40) + ".jpg"));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); // so the page can show it
    photoId = file.getId();
    blurred = req.photo.blurred === true;
  }
  return withLock_(() => {
    const it = {
      id: newId_("i"), tag: tag_(nextTagNo_(rows_("Items", ITEM_COLS))), name,
      cat: pick_(i.cat, CATS), place: pick_(i.place, PLACES), date: day_(i.date), desc: str_(i.desc, 500),
      status: "available", photoId, blurred, postedAt: new Date().toISOString(), releasedAt: ""
    };
    add_("Items", ITEM_COLS, it);
    return { ok: true, item: publicItem_(it) };
  });
}

function decide_(req) {
  const status = req.status === "approved" ? "approved" : req.status === "rejected" ? "rejected" : "";
  if (!status) return { ok: false, error: "bad_request" };
  return withLock_(() => {
    const c = rows_("Claims", CLAIM_COLS).filter(x => str_(x.cid) === str_(req.cid, 20))[0];
    if (!c) return { ok: false, error: "not_found" };
    if (cstatus_(c.status) !== "pending") return { ok: false, error: "already_closed" };
    const now = new Date().toISOString();
    c.status = status; c.decidedAt = now;
    save_("Claims", CLAIM_COLS, c);
    const it = rows_("Items", ITEM_COLS).filter(r => str_(r.id) === str_(c.itemId))[0];
    if (it) {
      if (status === "approved") { it.status = "claimed"; it.releasedAt = now; } else { it.status = "available"; }
      save_("Items", ITEM_COLS, it);
    }
    return { ok: true };
  });
}

function updateItem_(id, change) {
  return withLock_(() => {
    const it = rows_("Items", ITEM_COLS).filter(r => str_(r.id) && str_(r.id) === str_(id, 40))[0];
    if (!it) return { ok: false, error: "not_found" };
    change(it);
    save_("Items", ITEM_COLS, it);
    return { ok: true };
  });
}

function removeItem_(id) {
  return withLock_(() => {
    const it = rows_("Items", ITEM_COLS).filter(r => str_(r.id) && str_(r.id) === str_(id, 40))[0];
    if (!it) return { ok: false, error: "not_found" };
    sheet_("Items").deleteRow(it._row);
    if (str_(it.photoId)) { try { DriveApp.getFileById(str_(it.photoId)).setTrashed(true); } catch (e) { /* already gone */ } }
    return { ok: true };
  });
}

/* Runs daily (set up by setup) and whenever staff open the claims list. */
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
  } finally { lock.releaseLock(); }
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
  if (s === "returned" || s === "released" || s === "claim pending") return s === "claim pending" ? "pending" : "claimed";
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
