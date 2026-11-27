const path=require('path'),os=require('os');const ROOT=path.join(__dirname,'..'),TMP=os.tmpdir(),IMG=path.join(__dirname,'fixtures','idcard.png');
// Tests for: edit items, item photo on claims, multiple claims, email notifications, report alerts.
const {chromium}=require('playwright');const fs=require('fs');const {makeEnv}=require('./gas-mock');
const API='https://script.google.com/macros/s/TESTDEPLOY123/exec';
const env=makeEnv(),G=env.ctx;let ok=true;const check=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)ok=false};
G.doGet({parameter:{}});Object.assign(env.props,{STAFF_USER:'admin',STAFF_SALT:'s',STAFF_HASH:G.hash_('sOfficePass2026')});
check(!!env.sheets.Reports,'Reports tab is created automatically');
fs.writeFileSync(path.join(TMP,'page-new.html'),fs.readFileSync(path.join(ROOT,'index.html'),'utf8').replace(/const API_URL="[^"]*";/,`const API_URL="${API}";`));
(async()=>{
 const b=await chromium.launch(),errs=[];
 const mk=async()=>{const c=await b.newContext({viewport:{width:1280,height:900}});
   await c.route(API+'**',async route=>{const r=route.request();const res=r.method()==='GET'?G.doGet({parameter:Object.fromEntries(new URL(r.url()).searchParams)}):G.doPost({postData:{contents:r.postData()}});
     await route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:res.content})});
   await c.route('https://drive.google.com/thumbnail**',r=>r.fulfill({status:200,contentType:'image/png',body:fs.readFileSync(IMG)}));
   const p=await c.newPage();p.on('pageerror',e=>errs.push(e.message));p.on('dialog',d=>d.accept());await p.goto('file://'+path.join(TMP,'page-new.html'));await p.waitForTimeout(500);return p};
 const signIn=async(p,name,no,contact)=>{await p.click('#signBtn');await p.click('#tabStu');await p.fill('#pName',name);await p.fill('#pNo',no);await p.fill('#pContact',contact);await p.click('#pBtn');await p.waitForTimeout(150)};
 const staffIn=async p=>{await p.click('#footStaff');await p.fill('#aUser','admin');await p.fill('#aPass','OfficePass2026');await p.click('#aBtn');await p.waitForTimeout(500)};
 // --- student files a lost-item report with an email -> email alerts on
 const stu=await mk();
 await signIn(stu,'Ana Lim','2025-200001','ana@example.edu');
 await stu.selectOption('#lCat','Calculator');await stu.fill('#lItem','Casio fx-991');await stu.fill('#lDesc','My name on the back');await stu.check('#lConsent');await stu.click('#lostBtn');await stu.waitForTimeout(400);
 check((await stu.textContent('#lostMsg')).includes("We'll email ana@example.edu"),'report with email turns on match alerts');
 check(env.sheets.Reports.data[1][2]==='ana@example.edu'&&env.sheets.Reports.data[1][3]==='Calculator','report saved in the Reports tab');
 check(await stu.isVisible('text=Email alerts on'),'My requests shows "Email alerts on"');
 // a student with only a mobile number: report stays on the phone
 const stu2=await mk();await signIn(stu2,'Ben Cruz','2025-200002','0917 000 0000');
 await stu2.selectOption('#lCat','Calculator');await stu2.fill('#lItem','Calculator');await stu2.fill('#lDesc','Gray');await stu2.check('#lConsent');await stu2.click('#lostBtn');await stu2.waitForTimeout(300);
 check((await stu2.textContent('#lostMsg')).includes('Sign in with an email')&&env.sheets.Reports.getLastRow()===2,'report without an email stays on the phone only');
 // --- staff posts a matching item -> Ana gets a match email (once)
 const st=await mk();await staffIn(st);
 await st.fill('#sName','Casio scientific calculator');await st.selectOption('#sCat','Calculator');await st.selectOption('#sPlace','Library');
 await st.setInputFiles('#sPhoto',IMG);await st.waitForTimeout(600);await st.click('#foundBtn');await st.waitForTimeout(600);
 check((await st.textContent('#foundMsg'))==='Posted as LF-0101.','staff posted LF-0101');
 const match=env.mail.filter(m=>m.to==='ana@example.edu'&&/Possible match/.test(m.subject));
 check(match.length===1&&/#item-i/.test(match[0].body)&&/Stop alerts/.test(match[0].body),'Ana got one "Possible match" email with a link to the item');
 // --- edit the item: new name, category stays, remove photo
 const photoBefore=Object.keys(env.files)[0];
 await st.click('[data-edit]');await st.waitForTimeout(200);
 check((await st.textContent('#fTitle'))==='Edit LF-0101'&&(await st.inputValue('#sName'))==='Casio scientific calculator','Edit opens the form filled in');
 check(await st.isVisible('#sCur'),'edit form shows the current photo');
 await st.fill('#sName','Casio fx-991ES calculator');await st.fill('#sDesc','Black, found at a study table');await st.check('#sRmPhoto');await st.click('#foundBtn');await st.waitForTimeout(600);
 const row=env.sheets.Items.data[1];
 check((await st.textContent('#foundMsg'))==='Saved changes to LF-0101.'&&row[2]==='Casio fx-991ES calculator'&&row[6]==='Black, found at a study table'&&row[8]==='','edit saved to the sheet (name, description, photo removed)');
 check(env.files[photoBefore].trashed===true,'old photo moved to Drive trash');
 check(env.mail.filter(m=>m.to==='ana@example.edu'&&/Possible match/.test(m.subject)).length===1,'editing does not send Ana a duplicate match email');
 check((await st.textContent('#fTitle'))==='Post a found item','form is back to "Post a found item" after saving');
 // edit again with a new photo, then cancel another edit
 await st.click('[data-edit]');await st.setInputFiles('#sPhoto',IMG);await st.waitForTimeout(600);await st.click('#foundBtn');await st.waitForTimeout(600);
 check(!!env.sheets.Items.data[1][8],'edit can add a new photo');
 await st.click('[data-edit]');await st.click('#editCancel');check((await st.textContent('#fTitle'))==='Post a found item','Cancel editing resets the form');
 // --- two students claim; staff sees item photo + both claims; approve one
 await stu.reload();await stu.waitForTimeout(500);
 await stu.click('article:has-text("LF-0101") [data-claim]');await stu.fill('#cProof','My name ANA LIM is scratched on the back');await stu.check('#cConsent');await stu.click('#cBtn');await stu.waitForTimeout(400);
 check((await stu.textContent('#cMsg')).includes("we'll email ana@example.edu with the result"),'claim message promises an email');
 await stu.keyboard.press('Escape');
 check(await stu.isVisible('article:has-text("LF-0101") button:has-text("Claim sent")'),'board shows "Claim sent" for your own claim');
 await stu2.reload();await stu2.waitForTimeout(500);
 check(await stu2.isVisible('article:has-text("LF-0101") [data-claim]'),'another student can still click "This is mine" on a pending item');
 await stu2.click('article:has-text("LF-0101") [data-claim]');await stu2.fill('#cProof','gray calculator');await stu2.check('#cConsent');await stu2.click('#cBtn');await stu2.waitForTimeout(400);
 check((await stu2.textContent('#cMsg')).includes('check My requests'),'student without email is told to check My requests');
 await st.reload();await st.waitForTimeout(700);
 const card=await st.innerText('.cgroup:has-text("LF-0101")');
 check(card.includes('2 people claim this item')&&card.includes('Ana Lim')&&card.includes('Ben Cruz')&&card.includes('Their proof:'),'staff sees both claims grouped under the item');
 check(await st.isVisible('.cgroup:has-text("LF-0101") .cthumb img'),'claim card shows the item photo');
 check((await st.textContent('#claimHead'))==='Claim requests (2)','heading counts the claims');
 await st.click('.cclaim:has-text("Ana Lim") [data-ok]');await st.waitForTimeout(700);
 const cl=env.sheets.Claims.data;check(cl[1][9]==='approved'&&cl[2][9]==='rejected','approving Ana closed Ben\'s claim');
 check(env.mail.some(m=>m.to==='ana@example.edu'&&/^Approved/.test(m.subject)),'Ana got an "Approved" email');
 check(!env.mail.some(m=>m.to.includes('0917')),'no email attempted to a mobile number');
 await stu.reload();await stu.waitForTimeout(600);check((await stu.innerText('#mineList')).includes('Approved: pick up now'),'Ana sees Approved on the site');
 // --- Mark claimed closes open claims and emails them
 await st.fill('#sName','Black umbrella');await st.selectOption('#sCat','Umbrella');await st.click('#foundBtn');await st.waitForTimeout(500);
 const umb=JSON.parse(G.doGet({parameter:{}}).content).items.find(i=>i.name==='Black umbrella');
 G.doPost({postData:{contents:JSON.stringify({action:'claim',itemId:umb.id,name:'Cara Uy',studentNo:'2025-200003',contact:'cara@example.edu',proof:'mine',consent:true})}});
 await st.reload();await st.waitForTimeout(600);await st.click('tr:has-text("Black umbrella") [data-release]');await st.waitForTimeout(600);
 check(env.mail.some(m=>m.to==='cara@example.edu'&&/Update on your claim/.test(m.subject)),'Mark claimed closes open claims and emails the claimant');
 // --- Stop alerts deletes the report
 await stu.click('[data-unreport]');await stu.waitForTimeout(400);
 check(env.sheets.Reports.getLastRow()<=1&&!(await stu.isVisible('text=Email alerts on')),'Stop alerts deletes the report from the sheet');
 // --- reports older than 30 days are deleted
 G.doPost({postData:{contents:JSON.stringify({action:'report',name:'Old One',email:'old@example.edu',cat:'Bag',date:'2026-10-01',item:'Bag',place:'',consent:true})}});
 env.sheets.Reports.data[env.sheets.Reports.getLastRow()-1][7]=new Date(Date.now()-31*864e5).toISOString();G.purgeOldClaims();
 check(env.sheets.Reports.getLastRow()<=1,'reports older than 30 days are deleted');
 check(errs.length===0,'no page errors '+JSON.stringify(errs));
 await b.close();console.log(ok?'ALL PASSED':'SOME FAILED');
})().catch(e=>{console.error(e);process.exit(1)});
