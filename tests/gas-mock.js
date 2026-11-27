// Minimal stand-ins for the Google Apps Script services Code.gs uses.
const vm=require('vm'),crypto=require('crypto'),fs=require('fs'),path=require('path');
function makeEnv(){
  const sheets={},props={},cache={},files={};let uiAvailable=false;
  function Sheet(name){this.name=name;this.data=[];this.max=1000;}
  Sheet.prototype.getMaxRows=function(){return this.max};
  Sheet.prototype.getLastRow=function(){for(let r=this.data.length;r>0;r--){if((this.data[r-1]||[]).some(v=>v!==""&&v!==undefined))return r}return 0};
  Sheet.prototype.setFrozenRows=function(){};
  Sheet.prototype.insertRowsAfter=function(a,n){this.max+=n};
  Sheet.prototype.deleteRow=function(r){this.data.splice(r-1,1)};
  Sheet.prototype.getRange=function(row,col,nr=1,nc=1){const sh=this;if(row+nr-1>sh.max)throw new Error('Range outside sheet');return{
    setValues(v){v.forEach((rv,i)=>{const r=row-1+i;sh.data[r]=sh.data[r]||[];rv.forEach((x,j)=>{sh.data[r][col-1+j]=x})});return this},
    getValues(){const out=[];for(let i=0;i<nr;i++){const r=sh.data[row-1+i]||[];const o=[];for(let j=0;j<nc;j++){const x=r[col-1+j];o.push(x===undefined?"":x)}out.push(o)}return out},
    setFontWeight(){return this},setNumberFormat(){return this}}};
  const ss={getUrl:()=>'https://docs.google.com/spreadsheets/d/TESTSHEET/edit',getSheetByName:n=>sheets[n]||null,insertSheet:n=>(sheets[n]=new Sheet(n))};
  const ctx={
    console,
    SpreadsheetApp:{getActive:()=>ss,getUi:()=>{if(!uiAvailable)throw new Error('Cannot call getUi from this context');}},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>{props[k]=String(v)},setProperties:o=>Object.assign(props,o)})},
    CacheService:{getScriptCache:()=>({get:k=>cache[k]??null,put:(k,v)=>{cache[k]=v},remove:k=>{delete cache[k]}})},
    LockService:{getScriptLock:()=>({waitLock(){},tryLock(){return true},releaseLock(){}})},
    Utilities:{getUuid:()=>crypto.randomUUID(),sleep(){},DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
      computeDigest:(a,s)=>[...crypto.createHash('sha256').update(s,'utf8').digest()].map(b=>b>127?b-256:b),
      base64Encode:b=>Buffer.from(b.map(x=>x&255)).toString('base64'),base64Decode:s=>[...Buffer.from(s,'base64')],
      newBlob:(bytes,type,name)=>({bytes,type,name}),
      formatDate:(d,tz)=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`}},
    DriveApp:{Access:{ANYONE_WITH_LINK:'anyone_with_link'},Permission:{VIEW:'view'},
      createFolder:n=>({getId:()=>'folder1',createFile:blob=>{const id='file'+crypto.randomBytes(8).toString('hex');files[id]={blob,sharing:null,trashed:false};return{getId:()=>id,setSharing:(a,p)=>{files[id].sharing=a+'/'+p}}}}),
      getFolderById:id=>ctx.DriveApp.createFolder(),getFileById:id=>({setTrashed:t=>{if(files[id])files[id].trashed=t}})},
    ScriptApp:{getProjectTriggers:()=>[],newTrigger:()=>{const c={timeBased:()=>c,everyDays:()=>c,atHour:()=>c,inTimezone:()=>c,create:()=>{ctx.__trigger=true}};return c}},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({content:s,setMimeType(){return this}})},
    Logger:{log(){}},
    MailApp:{sent:[],getRemainingDailyQuota:()=>100,sendEmail(o){this.sent.push(o)}},
    Session:{getEffectiveUser:()=>({getEmail:()=>'owner@example.com'})}};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','apps-script','Code.gs'),'utf8'),ctx,{filename:'Code.gs'});
  return {ctx,sheets,props,cache,files,mail:ctx.MailApp.sent};
}
module.exports={makeEnv};
