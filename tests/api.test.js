const path=require('path'),os=require('os');const ROOT=path.join(__dirname,'..'),TMP=os.tmpdir(),IMG=path.join(__dirname,'fixtures','idcard.png');
const {chromium}=require('playwright');const fs=require('fs');const {makeEnv}=require('./gas-mock');
const API='https://script.google.com/macros/s/TESTDEPLOY123/exec';
const env=makeEnv(),G=env.ctx;const log=(...a)=>console.log(...a);let ok=true;const check=(c,m)=>{log((c?'PASS ':'FAIL ')+m);if(!c)ok=false};
// one-time setup, as staff would do from the sheet menu
G.doGet({parameter:{}});const salt='s4lt';Object.assign(env.props,{STAFF_USER:'admin',STAFF_SALT:salt,STAFF_HASH:G.hash_(salt+'OfficePass2026')});
check(!!env.sheets.Items&&!!env.sheets.Claims&&G.__trigger,'setup made Items + Claims tabs and the daily purge trigger');
// staff typed one row by hand (name, lower-case category, US date)
env.sheets.Items.data[1]=['','','Gray umbrella','umbrella','Library','11/20/2026','Hook handle','','','','',''];
const page=fs.readFileSync(path.join(ROOT,'index.html'),'utf8').replace(/const API_URL="[^"]*";/,`const API_URL="${API}";`);
fs.writeFileSync(path.join(TMP,'page-api.html'),page);
let calls=[];
(async()=>{
 const b=await chromium.launch();const errs=[];
 const ctxB=await b.newContext({viewport:{width:1280,height:900}});
 await ctxB.route(API+'**',async route=>{const r=route.request();let res;
   if(r.method()==='GET'){const u=new URL(r.url());res=G.doGet({parameter:Object.fromEntries(u.searchParams)})}
   else res=G.doPost({postData:{contents:r.postData()}});
   const body=res.content;calls.push({m:r.method(),body:r.postData()||r.url(),res:body});
   await route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body})});
 await ctxB.route('https://drive.google.com/thumbnail**',route=>route.fulfill({status:200,contentType:'image/png',body:fs.readFileSync(IMG)}));
 const p=await ctxB.newPage();p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
 p.on('dialog',d=>d.accept());
 await p.goto('file://'+path.join(TMP,'page-api.html'));await p.waitForTimeout(600);
 const note=await p.textContent('#srcNote');check(note.startsWith('Posted by the Security Office'),'page pulled items from the API: '+note);
 check(await p.isVisible('text=LF-0101'),'hand-typed sheet row got tag LF-0101 and shows on the board');
 check(env.sheets.Items.data[1][3]==='Umbrella'&&env.sheets.Items.data[1][5]==='2026-11-20','hand-typed row normalised in the sheet (category, date)');
 const pub=JSON.parse(calls.find(c=>c.m==='GET').res);check(!JSON.stringify(pub).match(/studentNo|contact|proof/),'public items response has no personal fields');
 // staff login wrong then right
 await p.click('#footStaff');await p.fill('#aUser','admin');await p.fill('#aPass','lostfound2026');await p.click('#aBtn');await p.waitForTimeout(300);
 check((await p.textContent('#pMsg'))==='Wrong username or password.','demo password does NOT work against the real API');
 await p.fill('#aPass','OfficePass2026');await p.click('#aBtn');await p.waitForTimeout(500);
 check(await p.isVisible('#staff'),'staff panel opens after server-checked login');
 check(await p.isVisible('#sheetLink')&&(await p.getAttribute('#sheetLink','href'))==='https://docs.google.com/spreadsheets/d/TESTSHEET/edit'&&(await p.getAttribute('#sheetLink','target'))==='_blank','Open Google Sheet button shows for staff with the sheet link');
 check(!page.includes('OfficePass2026'),'real staff password is not in the page');
 // post an ID with photo (blurred)
 await p.fill('#sName','NU student ID');await p.selectOption('#sCat','ID');await p.selectOption('#sPlace','Canteen');
 await p.setInputFiles('#sPhoto',IMG);await p.waitForTimeout(700);await p.click('#foundBtn');await p.waitForTimeout(700);
 check((await p.textContent('#foundMsg'))==='Posted as LF-0102.','staff posted LF-0102 through the API');
 const fileIds=Object.keys(env.files);check(fileIds.length===1&&env.files[fileIds[0]].sharing==='anyone_with_link/view','photo saved to Drive and shared view-only');
 check(await p.isVisible('article:has-text("LF-0102") .blurtag'),'posted photo shows with "Blurred for privacy"');
 check(await p.$eval('article:has-text("LF-0102") img',i=>i.src.includes('drive.google.com/thumbnail?id='+''))&&true,'photo is loaded from Drive');
 // staff log out, student claims
 await p.click('#signBtn');await p.click('#staffOut');await p.waitForTimeout(200);
 check(!(await p.isVisible('#sheetLink')),'button hidden after staff log out');
 await p.click('article:has-text("LF-0102") [data-claim]');await p.fill('#pName','Juan Dela Cruz');await p.fill('#pNo','2025-123456');await p.fill('#pContact','jdc@example.edu');await p.click('#pBtn');
 await p.fill('#cProof','Blue lanyard with a keychain');await p.check('#cConsent');await p.click('#cBtn');await p.waitForTimeout(600);
 const cmsg=await p.textContent('#cMsg');check(/Claim sent. Your reference is CL-[0-9A-F]{8}/.test(cmsg),'claim stored: '+cmsg.slice(0,40));
 const claimRow=env.sheets.Claims.data[1];check(claimRow&&claimRow[5]==='2025-123456'&&claimRow[9]==='pending','claim row in Claims tab with student details');
 await p.keyboard.press('Escape');
 check((await p.innerText('#mineList')).includes('Claim pending'),'My requests shows pending');
 // a second student can still claim the same item; the same student can't claim twice
 const lf102=JSON.parse(calls.filter(c=>c.m==='GET').pop().res).items.find(i=>i.tag==='LF-0102');
 const claimAs=(no,proof)=>JSON.parse(G.doPost({postData:{contents:JSON.stringify({action:'claim',itemId:lf102.id,name:'Kyla Ramos',studentNo:no,contact:'kyla@example.edu',proof,consent:true})}}).content);
 const r2=claimAs('2024-111111','White lanyard I think');check(r2.ok===true,'a second student can claim the same pending item');
 const r2b=claimAs('2024-111111','again');check(r2b.error==='already_claimed','the same student cannot claim the same item twice');
 check(env.mail.filter(m=>m.to==='owner@example.com'&&/New claim/.test(m.subject)).length===2,'staff got a new-claim email for each claim');
 check(/2 claims to compare/.test(env.mail.at(-1).body),'second new-claim email says there are 2 claims to compare');
 // staff without token cannot read claims
 const r3=JSON.parse(G.doPost({postData:{contents:JSON.stringify({action:'staff',op:'claims',token:'guess'})}}).content);check(r3.error==='login_expired','claims list needs a staff login');
 // staff approves
 await p.click('#signBtn');await p.click('#tabStaff');await p.fill('#aUser','admin');await p.fill('#aPass','OfficePass2026');await p.click('#aBtn');await p.waitForTimeout(600);
 check((await p.innerText('#claimList')).includes('Juan Dela Cruz'),'staff sees the claim with details');
 check(await p.isVisible('.cgroup:has-text("LF-0102") .cthumb img'),'claim card shows the item photo');
 check((await p.innerText('.cgroup:has-text("LF-0102")')).includes('2 people claim this item'),'both claims are grouped under the item');
 await p.click('[data-ok]');await p.waitForTimeout(700);
 check(env.sheets.Claims.data[1][9]==='approved'&&env.sheets.Items.data.find(r=>r&&r[1]==='LF-0102')[7]==='claimed','approval saved in both tabs');
 check(env.sheets.Claims.data[2][9]==='rejected','approving Juan closed Kyla\'s claim automatically');
 check(env.mail.some(m=>m.to==='jdc@example.edu'&&/^Approved/.test(m.subject)&&/Bring your NU ID/.test(m.body)),'Juan got an "Approved" email');
 check(env.mail.some(m=>m.to==='kyla@example.edu'&&/Update on your claim/.test(m.subject)),'Kyla got a "not approved" email');
 check((await p.innerText('#tiles')).includes('Returned to owners'),'office numbers update: '+(await p.innerText('#tiles')).replace(/\s+/g,' '));
 // student comes back (reload: details remembered on this device)
 await p.click('#signBtn');await p.click('#staffOut');await p.reload();await p.waitForTimeout(800);
 check((await p.textContent('#signBtn'))==='Juan','student sign-in remembered on this device after reload');
 check((await p.innerText('#mineList')).includes('Approved: pick up now'),'student sees Approved after reload (pulled from API)');
 // 30-day deletion
 env.sheets.Claims.data[1][11]=new Date(Date.now()-31*864e5).toISOString();
 const loginR=JSON.parse(G.doPost({postData:{contents:JSON.stringify({action:'login',user:'admin',password:'OfficePass2026'})}}).content);
 G.doPost({postData:{contents:JSON.stringify({action:'staff',op:'claims',token:loginR.token})}});
 const row=env.sheets.Claims.data[1];check(row[4]===''&&row[5]===''&&row[6]===''&&row[7]===''&&row[12]==='true','claimant details deleted after 30 days');
 // expired staff session
 await p.click('#signBtn');await p.click('#tabStaff');await p.fill('#aUser','admin');await p.fill('#aPass','OfficePass2026');await p.click('#aBtn');await p.waitForTimeout(500);
 for(const k of Object.keys(env.cache))delete env.cache[k];
 await p.click('[data-release]');await p.waitForTimeout(500);
 check(await p.isVisible('#ovSign')&&(await p.textContent('#pMsg')).includes('session ended'),'expired staff session asks to log in again');
 await p.keyboard.press('Escape');
 // remove item
 await p.click('#signBtn');await p.click('#tabStaff');await p.fill('#aUser','admin');await p.fill('#aPass','OfficePass2026');await p.click('#aBtn');await p.waitForTimeout(500);
 await p.click('[data-del]');await p.waitForTimeout(500);check(!(await p.isVisible('text=LF-0101')),'staff removed LF-0101 (with confirm)');
 await p.screenshot({path:path.join(TMP,'api-staff.png')});
 check(errs.length===0,'no page errors '+JSON.stringify(errs));
 await b.close();log(ok?'ALL PASSED':'SOME FAILED');
})().catch(e=>{console.error(e);process.exit(1)});
