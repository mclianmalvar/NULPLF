const path=require('path'),os=require('os');const ROOT=path.join(__dirname,'..'),TMP=os.tmpdir(),IMG=path.join(__dirname,'fixtures','idcard.png');
// Tests for: "kept until" dates, share button and shared links, camera button, pickup + release slip,
// pickup reminder emails, email-problem warnings for staff, and the visit counter.
const {chromium}=require('playwright');const fs=require('fs');const {makeEnv}=require('./gas-mock');
const API='https://script.google.com/macros/s/TESTDEPLOY123/exec';
const env=makeEnv(),G=env.ctx;let ok=true;const check=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)ok=false};
const post=o=>JSON.parse(G.doPost({postData:{contents:JSON.stringify(o)}}).content);
G.doGet({parameter:{}});Object.assign(env.props,{STAFF_USER:'admin',STAFF_SALT:'s',STAFF_HASH:G.hash_('sOfficePass2026')});
const token=post({action:'login',user:'admin',password:'OfficePass2026'}).token;
const staff=(op,o={})=>post({action:'staff',op,token,...o});
const CLAIM_COLS=require('vm').runInContext('CLAIM_COLS',G),claimCol=n=>CLAIM_COLS.indexOf(n);

// --- server: visit counter
check(!!env.sheets.Visits,'Visits tab is created automatically');
post({action:'visit'});post({action:'visit'});
check(String(env.sheets.Visits.data[1][1])==='2','two visits today are counted in one row');
check(JSON.stringify(staff('claims').visits)==='{"today":2,"week":2,"month":2}','staff see visits today, this week and this month');
env.sheets.Visits.data.push([new Date(Date.now()-10*864e5).toISOString().slice(0,10),5]);
check(JSON.stringify(staff('claims').visits)==='{"today":2,"week":2,"month":7}','older visits count only toward the last 30 days');

// --- server: old Claims tab (13 columns) gets the new column names
env.sheets.Claims.data[0]=env.sheets.Claims.data[0].slice(0,13);
staff('claims');
check(env.sheets.Claims.data[0][13]==='pickedUpAt'&&env.sheets.Claims.data[0][14]==='remindedAt','Claims tab gets the pickedUpAt and remindedAt columns');

// --- server: pickup and reminder emails
const it=staff('post',{item:{name:'Black umbrella',cat:'Umbrella',place:'Library',date:'2026-11-20',desc:''}}).item;
const c1=post({action:'claim',itemId:it.id,name:'Ana Lim',studentNo:'2025-300001',contact:'ana@example.edu',proof:'Wooden handle with my initials',consent:true}).cid;
check(staff('pickup',{cid:c1}).error==='not_approved','a pending claim cannot be marked picked up');
staff('decide',{cid:c1,status:'approved'});
const row=()=>env.sheets.Claims.data.find(r=>r[0]===c1);
row()[claimCol('decidedAt')]=new Date(Date.now()-4*864e5).toISOString();
const before=env.mail.length;G.purgeOldClaims();
const rem=env.mail.slice(before).filter(m=>m.to==='ana@example.edu'&&/^Reminder/.test(m.subject));
check(rem.length===1&&rem[0].body.includes(c1)&&rem[0].body.includes('NU ID'),'Ana gets one pickup reminder 4 days after approval');
check(!!row()[claimCol('remindedAt')],'reminder time is saved on the claim');
G.purgeOldClaims();
check(env.mail.filter(m=>/^Reminder/.test(m.subject)).length===1,'the reminder is sent only once');
const p1=staff('pickup',{cid:c1});
check(p1.ok&&!!p1.claim.pickedUpAt&&!!row()[claimCol('pickedUpAt')],'staff mark the claim picked up');
const it2=staff('post',{item:{name:'Blue tumbler',cat:'Tumbler',place:'Gym',date:'2026-11-20',desc:''}}).item;
const c2=post({action:'claim',itemId:it2.id,name:'Ben Cruz',studentNo:'2025-300002',contact:'ben@example.edu',proof:'Dent on the lid',consent:true}).cid;
staff('decide',{cid:c2,status:'approved'});staff('pickup',{cid:c2});
env.sheets.Claims.data.find(r=>r[0]===c2)[claimCol('decidedAt')]=new Date(Date.now()-5*864e5).toISOString();
const it3=staff('post',{item:{name:'Gray hoodie',cat:'Clothing',place:'Gym',date:'2026-11-20',desc:''}}).item;
const c3=post({action:'claim',itemId:it3.id,name:'Cara Uy',studentNo:'2025-300003',contact:'0917 111 2222',proof:'Size M',consent:true}).cid;
staff('decide',{cid:c3,status:'approved'});
env.sheets.Claims.data.find(r=>r[0]===c3)[claimCol('decidedAt')]=new Date(Date.now()-5*864e5).toISOString();
G.purgeOldClaims();
check(!env.mail.some(m=>m.to==='ben@example.edu'&&/^Reminder/.test(m.subject)),'no reminder after the item was picked up');
check(env.mail.filter(m=>/^Reminder/.test(m.subject)).length===1,'no reminder email is attempted to a mobile number');

// --- server: email problems are saved for the Staff panel
check(staff('claims').mail.problem===null,'no email problem when emails work');
const realSend=G.MailApp.sendEmail;
G.MailApp.sendEmail=function(){throw new Error('You do not have permission to call MailApp.sendEmail. Required permissions: https://www.googleapis.com/auth/script.send_mail')};
const it4=staff('post',{item:{name:'Car keys',cat:'Keys',place:'Canteen',date:'2026-11-21',desc:''}}).item;
post({action:'claim',itemId:it4.id,name:'Dan Yu',studentNo:'2025-300004',contact:'dan@example.edu',proof:'Blue tag',consent:true});
check(JSON.parse(env.props.MAIL_PROBLEM).kind==='permission','a failed email is saved as a permission problem');
const realQuota=G.MailApp.getRemainingDailyQuota;
G.MailApp.getRemainingDailyQuota=()=>{throw new Error('You do not have permission to call MailApp.getRemainingDailyQuota')};
check(staff('claims').mail.problem.kind==='permission','staff see the permission problem');
G.MailApp.getRemainingDailyQuota=realQuota;G.MailApp.sendEmail=realSend;
check(staff('claims').mail.problem===null&&!env.props.MAIL_PROBLEM,'the permission problem clears once permission is given');
G.MailApp.getRemainingDailyQuota=()=>0;
post({action:'claim',itemId:it4.id,name:'Eve Go',studentNo:'2025-300005',contact:'eve@example.edu',proof:'Three keys',consent:true});
const m2=staff('claims').mail;
check(m2.problem.kind==='quota'&&m2.quota===0,'an empty daily quota is reported');
G.MailApp.getRemainingDailyQuota=realQuota;
env.props.ALERT_EMAIL='';G.Session.getEffectiveUser=()=>({getEmail:()=>''});
check(staff('claims').mail.alertSet===false,'staff are told when no alert email is set');
env.props.ALERT_EMAIL='office@example.edu';delete env.props.MAIL_PROBLEM;

// --- browser
fs.writeFileSync(path.join(TMP,'page-extras.html'),fs.readFileSync(path.join(ROOT,'index.html'),'utf8').replace(/const API_URL="[^"]*";/,`const API_URL="${API}";`));
const PAGE='file://'+path.join(TMP,'page-extras.html');
(async()=>{
 const b=await chromium.launch(),errs=[];
 const mk=async(opts={},hash='')=>{const c=await b.newContext({viewport:{width:1280,height:900},...opts});
   await c.route(API+'**',async route=>{const r=route.request();const res=r.method()==='GET'?G.doGet({parameter:Object.fromEntries(new URL(r.url()).searchParams)}):G.doPost({postData:{contents:r.postData()}});
     await route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:res.content})});
   const p=await c.newPage();p.on('pageerror',e=>errs.push(e.message));p.on('dialog',d=>d.accept());await p.goto(PAGE+hash);await p.waitForTimeout(600);return p};
 const staffIn=async p=>{await p.click('#footStaff');await p.fill('#aUser','admin');await p.fill('#aPass','OfficePass2026');await p.click('#aBtn');await p.waitForTimeout(600)};

 // kept-until line, visit counted once per session
 const visitsBefore=Number(env.sheets.Visits.data[1][1]);
 const stu=await mk();
 const card=await stu.innerText('article:has-text("Car keys")');
 check(/Kept until Dec \d+/.test(card)||/Kept over 30 days|left\)/.test(card),'item card shows how long it is kept: '+card.split('\n').find(l=>/Kept/.test(l)));
 check(Number(env.sheets.Visits.data[1][1])===visitsBefore+1,'opening the site counts one visit');
 await stu.reload();await stu.waitForTimeout(500);
 check(Number(env.sheets.Visits.data[1][1])===visitsBefore+1,'reloading in the same session is not counted again');
 check(!(await stu.isVisible('#sCamBtn')),'Take photo button is hidden on a computer');

 // share button copies a link to the item
 await stu.context().grantPermissions(['clipboard-read','clipboard-write']);
 await stu.evaluate(()=>{Object.defineProperty(navigator,'share',{value:undefined,configurable:true})});
 await stu.click('article:has-text("Car keys") [data-share]');await stu.waitForTimeout(300);
 const copied=await stu.evaluate(()=>navigator.clipboard.readText());
 check(copied.endsWith('#item-'+it4.id)&&(await stu.textContent('#toast')).includes('Link copied'),'Share copies a link to the item');

 // opening a shared link scrolls to the item and highlights it
 const shared=await mk({},'#item-'+it4.id);
 const hl=await shared.evaluate(id=>{const e=document.getElementById('item-'+id);const r=e.getBoundingClientRect();return {hl:e.classList.contains('hl'),inView:r.top>=0&&r.bottom<=innerHeight}},it4.id);
 check(hl.hl&&hl.inView,'a shared link scrolls to the item and highlights it');
 const gone=await mk({},'#item-i000000000000');
 check((await gone.textContent('#toast')).includes("isn't on the board"),'a link to a removed item explains it is gone');

 // phone: Take photo button shows
 const phone=await mk({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 check(await phone.isVisible('#sCamBtn')||await phone.evaluate(()=>!document.querySelector('#sCamBtn').classList.contains('hide')),'Take photo button is shown on a phone');

 // staff: email warning, pickup + slip, Mark claimed + walk-in slip, visits line
 env.props.MAIL_PROBLEM=JSON.stringify({kind:'error',message:'Service invoked too many times',at:new Date().toISOString()});
 const st=await mk();await staffIn(st);
 check((await st.textContent('#mailWarn')).includes("The last email couldn't be sent")&&await st.isVisible('#mailWarn'),'staff panel warns about the email problem');
 delete env.props.MAIL_PROBLEM;
 check(/Site visits: \d+ today/.test(await st.textContent('#visitLine')),'office numbers show site visits');
 const it5=staff('post',{item:{name:'Black wallet',cat:'Wallet',place:'Library',date:'2026-11-22',desc:''}}).item;
 const c5=post({action:'claim',itemId:it5.id,name:'Fay Ong',studentNo:'2025-300006',contact:'fay@example.edu',proof:'Library card inside',consent:true}).cid;
 await st.reload();await st.waitForTimeout(700);
 await st.click(`.cclaim:has-text("Fay Ong") [data-ok]`);await st.waitForTimeout(700);
 check((await st.innerText(`#closedTbl tr:has-text("Black wallet")`)).includes('Waiting for pickup'),'approved claim shows "Waiting for pickup"');
 await st.click(`#closedTbl [data-pickup="${c5}"]`);await st.waitForTimeout(600);
 const slip=await st.innerText('#slip');
 check(await st.isVisible('#ovSlip')&&slip.includes('Release slip')&&slip.includes('Fay Ong')&&slip.includes('2025-300006')&&slip.includes(c5)&&slip.includes("Owner's signature"),'Picked up opens a release slip with the claim details');
 check(!!env.sheets.Claims.data.find(r=>r[0]===c5)[claimCol('pickedUpAt')],'pickup time saved in the Claims tab');
 await st.keyboard.press('Escape');
 check((await st.innerText(`#closedTbl tr:has-text("Black wallet")`)).includes('Picked up'),'closed claims show "Picked up" with Print slip');
 await st.emulateMedia({media:'print'});await st.evaluate(()=>{document.body.classList.add('printslip');document.querySelector('#ovSlip').classList.add('on')});
 const printView=await st.evaluate(()=>({nav:getComputedStyle(document.querySelector('nav')).display,slip:getComputedStyle(document.querySelector('#ovSlip')).display,btns:getComputedStyle(document.querySelector('.slipbtns')).display}));
 check(printView.nav==='none'&&printView.slip!=='none'&&printView.btns==='none','printing shows only the slip');
 await st.evaluate(()=>{document.body.classList.remove('printslip');document.querySelector('#ovSlip').classList.remove('on')});await st.emulateMedia({media:'screen'});
 await st.click('tr:has-text("Car keys") [data-release]');await st.waitForTimeout(700);
 const walk=await st.innerText('#slip');
 check(await st.isVisible('#ovSlip')&&walk.includes('Car keys')&&!walk.includes('Claim reference'),'Mark claimed opens a slip with blank owner lines');
 await st.keyboard.press('Escape');

 check(errs.length===0,'no page errors '+JSON.stringify(errs));
 await b.close();console.log(ok?'ALL PASSED':'SOME FAILED');
})().catch(e=>{console.error(e);process.exit(1)});
