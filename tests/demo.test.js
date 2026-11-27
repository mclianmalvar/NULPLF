const path=require('path'),os=require('os');const ROOT=path.join(__dirname,'..'),TMP=os.tmpdir(),IMG=path.join(__dirname,'fixtures','idcard.png');
const {chromium}=require('playwright');const fs=require('fs');
(async()=>{
 const b=await chromium.launch();const url=require('url').pathToFileURL(path.join(ROOT,'index.html')).href+'?demo';
 const errs=[];const log=(...a)=>console.log(...a);
 const p=await b.newPage({viewport:{width:1366,height:900}});p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
 // make a test "ID card" photo with readable text
 const data=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=2400;c.height=1600;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,2400,1600);x.fillStyle='#2337c6';x.fillRect(0,0,2400,300);x.fillStyle='#000';x.font='bold 160px sans-serif';x.fillText('JUAN DELA CRUZ',600,800);x.font='120px sans-serif';x.fillText('2025-123456',600,1050);x.fillStyle='#c96';x.fillRect(120,450,400,500);return c.toDataURL('image/png')});
 fs.writeFileSync(path.join(TMP,'idcard.png'),Buffer.from(data.split(',')[1],'base64'));
 await p.goto(url);await p.waitForTimeout(400);
 const st=async()=>p.evaluate(()=>({staff:!document.querySelector('#staff').classList.contains('hide'),staffLink:!document.querySelector('#staffLink').classList.contains('hide'),claimBtns:document.querySelectorAll('[data-claim]').length,signBtn:document.querySelector('#signBtn').textContent,note:document.querySelector('#srcNote').textContent}));
 log('1 start',JSON.stringify(await st()));
 // student claim -> sign in first
 await p.click('[data-claim="s1"]');
 log('2 modal title:',await p.textContent('#pTitle'),'| staff tab pressed:',await p.getAttribute('#tabStaff','aria-pressed'));
 await p.fill('#pName','Juan Dela Cruz');await p.type('#pNo','2025123456');log('  student no auto-format:',await p.inputValue('#pNo'));
 await p.fill('#pContact','jdc@example.edu');await p.click('#pBtn');await p.waitForTimeout(200);
 log('3 claim modal open:',await p.isVisible('#ovClaim'),'| who:',(await p.textContent('#cWho')).trim());
 await p.fill('#cProof','Small crack on the handle.');await p.click('#cBtn');await p.waitForTimeout(100);
 log('  without consent:',await p.textContent('#cMsg'));
 await p.check('#cConsent');await p.click('#cBtn');await p.waitForTimeout(200);
 log('  sent:',(await p.textContent('#cMsg')).slice(0,40));
 await p.keyboard.press('Escape');
 log('  my requests:',(await p.innerText('#mineList')).replace(/\n+/g,' | ').slice(0,120));
 log('  state:',JSON.stringify(await st()));
 // staff login: wrong then right
 await p.click('#signBtn');await p.click('#tabStaff');await p.fill('#aUser','admin');await p.fill('#aPass','nope');await p.click('#aBtn');
 log('4 wrong pw:',await p.textContent('#pMsg'));
 await p.fill('#aPass','lostfound2026');await p.click('#aBtn');await p.waitForTimeout(300);
 log('  logged in:',JSON.stringify(await st()));
 log('  pending:',(await p.innerText('#claimList')).replace(/\s+/g,' ').slice(0,220));
 log('  closed:',(await p.innerText('#closedTbl tbody')).replace(/\s+/g,' ').slice(0,400));
 log('  tiles:',(await p.innerText('#tiles')).replace(/\s+/g,' '));
 // approve Juan's claim
 const okBtn=await p.$('.cclaim:has-text("Juan Dela Cruz") [data-ok]');await okBtn.click();await p.waitForTimeout(200);
 log('5 after approve tiles:',(await p.innerText('#tiles')).replace(/\s+/g,' '));
 // post an ID with photo
 await p.fill('#sName','NU student ID');await p.selectOption('#sCat','ID');
 log('  blur auto-checked for ID:',await p.isChecked('#sBlur'));
 await p.setInputFiles('#sPhoto',IMG);await p.waitForTimeout(800);
 log('  photo note:',await p.textContent('#sPhotoNote'));
 await p.click('#foundBtn');await p.waitForTimeout(300);
 log('  posted:',await p.textContent('#foundMsg'));
 const tag=await p.$('article.tag:has-text("LF-0161")');await tag.scrollIntoViewIfNeeded();await tag.screenshot({path:path.join(TMP,'tag-blur.png')});
 await p.locator('#staff').screenshot({path:path.join(TMP,'staff.png')});
 // staff logout, student signs back in
 await p.click('#signBtn');await p.click('#staffOut');await p.waitForTimeout(200);
 log('6 after staff logout:',JSON.stringify(await st()));
 await p.click('#signBtn');await p.fill('#pName','Juan Dela Cruz');await p.fill('#pNo','2025-123456');await p.fill('#pContact','jdc@example.edu');await p.click('#pBtn');await p.waitForTimeout(200);
 log('  my requests:',(await p.innerText('#mineList')).replace(/\n+/g,' | ').slice(0,140));
 // report
 await p.fill('#lItem','Black umbrella');await p.selectOption('#lCat','Umbrella');await p.fill('#lDate',await p.evaluate(()=>document.querySelector('#lDate').max));
 await p.fill('#lDesc','Long, hook handle');await p.check('#lConsent');await p.click('#lostBtn');await p.waitForTimeout(200);
 log('7 report:',await p.textContent('#lostMsg'));
 log('errors:',errs);
 await p.close();
 // Manila 7 AM
 const ctx=await b.newContext({timezoneId:'Asia/Manila'});const q=await ctx.newPage();await q.clock.setFixedTime(new Date('2026-11-27T07:00:00+08:00'));await q.goto(url);
 log('8 Manila 7AM date max:',await q.$eval('#lDate',e=>e.max));
 // phone
 const ph=await b.newPage({viewport:{width:375,height:800},deviceScaleFactor:2});ph.on('pageerror',e=>errs.push(e.message));await ph.goto(url);await ph.waitForTimeout(300);
 log('9 phone nav h:',await ph.$eval('nav',e=>e.offsetHeight),'overflow:',await ph.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
 await ph.screenshot({path:path.join(TMP,'phone-top.png')});
 await ph.click('#menuBtn');await ph.screenshot({path:path.join(TMP,'phone-menu.png')});
 await ph.click('#navLinks a[href="#faq"]');await ph.waitForTimeout(600);log('  menu closed after link:',!(await ph.$eval('nav',e=>e.classList.contains('open'))));
 // phone staff panel dark
 const dk=await b.newPage({viewport:{width:375,height:800},colorScheme:'dark'});await dk.goto(url);await dk.waitForTimeout(300);
 await dk.click('#footStaff');await dk.fill('#aUser','admin');await dk.fill('#aPass','lostfound2026');await dk.click('#aBtn');await dk.waitForTimeout(400);
 log('  dark phone overflow:',await dk.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
 await dk.locator('#statsTitle').scrollIntoViewIfNeeded();await dk.evaluate(()=>scrollBy(0,-90));await dk.screenshot({path:path.join(TMP,'dark-stats.png')});
 log('errors final:',errs);
 await b.close();
})();
