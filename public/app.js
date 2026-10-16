const STATE_KEY="injectionReminder.state.v2",QUEUE_KEY="injectionReminder.queue.v2";
const RAW_API_BASE_URL=String(window.INJECTION_REMINDER_CONFIG?.apiBaseUrl||"");
const API_BASE_URL=RAW_API_BASE_URL.endsWith("/")?RAW_API_BASE_URL.slice(0,-1):RAW_API_BASE_URL;
const ids=["installGate","setupView","notificationSetup","homeView","statusPill","recheckInstall","anchorDate","saveSetup","enableNotifications","skipNotifications","countdown","nextDueDate","nextInjectionSide","doseText","doseDots","packageEmpty","confirmInjection","confirmHint","newPackage","historyList","resetApp","offlineBanner","pushWarning","toast","confirmDialog","confirmDialogText","dialogConfirmInjection","packageDialog","dialogConfirmPackage","missingSidePanel","saveMissingSide","pushDiagnostics","orderPackage","editTracking","refreshTracking","editTrackingDialog","editNextDue","editNextSide","editStock","editOrderPending","saveTrackingEdits","openSettings","closeSettings","settingsDrawer","manageNotifications","notificationDialog","saveNotifications","eveEnabled","eveTime","injectionTimes","addInjectionTime","purchaseEnabled","purchaseTime","scheduleCopy","pullIndicator","pullText","dueGauge","gaugeDays","gaugeLabel","gaugeNeedle","editDateToggle","editDateText","editCalendar","calendarPrev","calendarNext","calendarMonth","calendarGrid"];
const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
const defaultPrefs=()=>({eve:true,eveTime:"20:00",dayTimes:["10:00","14:00","18:00","22:00"],purchase:true,purchaseTime:"10:00"});
const validTime=t=>typeof t==="string"&&/^([01][0-9]|2[0-3]):(00|15|30|45)$/.test(t);
const normalizePrefs=v=>({eve:typeof v?.eve==="boolean"?v.eve:true,eveTime:validTime(v?.eveTime)?v.eveTime:"20:00",dayTimes:Array.isArray(v?.dayTimes)?[...new Set(v.dayTimes.filter(validTime))].sort().slice(0,8):defaultPrefs().dayTimes,purchase:typeof v?.purchase==="boolean"?v.purchase:true,purchaseTime:validTime(v?.purchaseTime)?v.purchaseTime:"10:00"});
const defaults=()=>({notificationPrefs:defaultPrefs(),configured:false,anchorDate:"",nextDueDate:"",lastInjectionSide:null,nextInjectionSide:null,dosesRemaining:2,orderPending:false,history:[],deviceId:crypto.randomUUID(),notificationSetupSeen:false,pushSynced:false});
function load(){try{const data=JSON.parse(localStorage.getItem(STATE_KEY))||{};return {...defaults(),...data,notificationPrefs:normalizePrefs(data.notificationPrefs)};}catch{return defaults();}}
let state=load(),selectedDose=2,selectedSide=null,toastTimer,draftPrefs=null,calendarDate=new Date(),lockedScrollY=0,pullStartY=null,pullDistance=0,pullBusy=false;
const save=()=>localStorage.setItem(STATE_KEY,JSON.stringify(state));
const isoLocal=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-");
const parseDate=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d,12);};
const addDays=(s,n)=>{const d=parseDate(s);d.setDate(d.getDate()+n);return isoLocal(d);};
const oppositeSide=side=>side==="right"?"left":side==="left"?"right":null;
const sideLabel=side=>side==="right"?"ירך ימין":side==="left"?"ירך שמאל":"יש להשלים צד";
const formatDate=s=>s?new Intl.DateTimeFormat("he-IL",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(parseDate(s)):"—";
function daysUntil(s){const n=new Date();return Math.round((parseDate(s)-new Date(n.getFullYear(),n.getMonth(),n.getDate(),12))/86400000);}
function countdown(s){const n=daysUntil(s);return n===0?"היום":n===1?"מחר":n>1?`בעוד ${n} ימים`:n===-1?"באיחור של יום":`באיחור של ${-n} ימים`;}
const standalone=()=>matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
const ios=()=>/iphone|ipad|ipod/i.test(navigator.userAgent);
const dueNow=()=>state.configured&&daysUntil(state.nextDueDate)<=0;
const timezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||"Asia/Jerusalem";
function toast(message){clearTimeout(toastTimer);el.toast.textContent=message;el.toast.classList.remove("hidden");toastTimer=setTimeout(()=>el.toast.classList.add("hidden"),4500);}
function queue(path,body,method){let q=[];try{q=JSON.parse(localStorage.getItem(QUEUE_KEY)||"[]");}catch{}q.push({path,body,method});localStorage.setItem(QUEUE_KEY,JSON.stringify(q.slice(-60)));}
async function device(path,body,method="POST",queueFailure=false){
 try{
  if(!API_BASE_URL)throw Error("backend_unavailable");
  const response=await fetch(`${API_BASE_URL}/api/device/${encodeURIComponent(state.deviceId)}${path}`,{method,headers:body===undefined?undefined:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw Error("HTTP "+response.status);
  return await response.json();
 }catch(err){if(queueFailure)queue(path,body,method);throw err;}
}
async function flush(){
 if(!navigator.onLine)return;
 let q=[];try{q=JSON.parse(localStorage.getItem(QUEUE_KEY)||"[]");}catch{}
 const remaining=[];
 for(const job of q){try{await device(job.path,job.body,job.method);}catch{remaining.push(job);}}
 localStorage.setItem(QUEUE_KEY,JSON.stringify(remaining));
}
async function registerServiceWorker(){
 if(!("serviceWorker" in navigator))throw Error("unsupported");
 await navigator.serviceWorker.register("./sw.js",{scope:"./"});
 return navigator.serviceWorker.ready;
}
function decodeKey(base64){
 const padded=(base64+"=".repeat((4-base64.length%4)%4)).replace(/-/g,"+").replace(/_/g,"/");
 return Uint8Array.from(atob(padded),char=>char.charCodeAt(0));
}

let pushStage="בדיקת התאימות";
const setPushStage=stage=>{pushStage=stage};
function showPushFailure(error){
 const code=String(error?.name||"Error");
 const detail=String(error?.message||"unknown").slice(0,160);
 const permission=("Notification" in window)?Notification.permission:"unsupported";
 let help="נסה שוב כשהאפליקציה פתוחה ממסך הבית ויש חיבור לאינטרנט.";
 if(detail==="denied"||permission==="denied"||code==="NotAllowedError")help="פתח הגדרות iPhone ← עדכונים ← תזכורת הזרקה, ואפשר התראות.";
 else if(detail==="unsupported"||detail==="install_required")help="פתח את האפליקציה מהאייקון במסך הבית, ולא מלשונית Safari.";
 else if(detail==="permission_required")help="יש לאשר את בקשת ההרשאה של iOS.";
 else if(detail==="backend_unavailable"||detail==="config_failed"||detail.startsWith("HTTP ")||code==="TypeError")help="לא הושלם החיבור לשרת ההתראות. ודא שקיים חיבור אינטרנט ונסה שוב.";
 const text="הבדיקה נעצרה בשלב: "+pushStage+". הרשאת iOS: "+permission+". שגיאה: "+code+" / "+detail+". "+help;
 el.pushDiagnostics.textContent=text;
 el.pushDiagnostics.classList.remove("hidden");
 toast("בדיקת ההתראות נכשלה — פרטים מופיעים בתחתית ההגדרות.");
}
function clearPushFailure(){
 el.pushDiagnostics.textContent="";
 el.pushDiagnostics.classList.add("hidden");
}
async function subscribe(userGesture=false){
 setPushStage("בדיקת תמיכת iOS והתקנה");
 if(ios()&&!standalone())throw Error("install_required");
 if(!("Notification" in window)||!("PushManager" in window))throw Error("unsupported");
 if(Notification.permission==="denied")throw Error("denied");
 // Ask before the first await so iOS recognizes the user interaction.
 setPushStage("בקשת הרשאה להתראות ב-iPhone");
 let permission=Notification.permission;
 if(permission==="default"&&userGesture)permission=await Notification.requestPermission();
 if(permission!=="granted")throw Error("permission_required");
 setPushStage("הפעלת Service Worker");
 const registration=await registerServiceWorker();
 setPushStage("חיבור ל-Cloudflare לקבלת מפתח Push");
 if(!API_BASE_URL)throw Error("backend_unavailable");
 const response=await fetch(`${API_BASE_URL}/api/config`,{cache:"no-store"});
 if(!response.ok)throw Error("config_failed");
 const {publicKey,vapidPublicKey}=await response.json();
 const key=publicKey||vapidPublicKey;
 if(typeof key!=="string"||!key)throw Error("invalid_vapid_key");
 setPushStage("רישום המכשיר ב-Apple Push");
 let subscription=await registration.pushManager.getSubscription();
 if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeKey(key)});
 setPushStage("שמירת הרשמת המכשיר ב-Cloudflare");
 await device("/subscription",{subscription:subscription.toJSON()});
 state.pushSynced=true;save();return true;
}
function notifyStatus(){
 const granted=("Notification" in window)&&Notification.permission==="granted"&&(!ios()||standalone());
 if(!API_BASE_URL){
  el.statusPill.textContent="Push בהכנה";
  el.statusPill.className="status-pill";
  el.pushWarning.classList.add("hidden");
  return;
 }
 const active=granted&&state.pushSynced;
 el.statusPill.textContent=active?"התראות פעילות":granted?"יש לבדוק חיבור התראות":"התראות כבויות";
 el.statusPill.className="status-pill "+(active?"ok":"bad");
 el.pushWarning.classList.toggle("hidden",active||!state.configured||!state.notificationSetupSeen);
}
function renderHistory(){
 if(!state.history.length){el.historyList.innerHTML='<div class="history-empty">עדיין אין הזרקות שנרשמו.</div>';return;}
 const fmt=new Intl.DateTimeFormat("he-IL",{dateStyle:"medium",timeStyle:"short"});
 el.historyList.innerHTML=state.history.slice().reverse().map(x=>`<div class="history-item"><div><strong>${formatDate(x.scheduledDate)}</strong><br><span>${x.injectionSide?sideLabel(x.injectionSide)+" · ":""}מועד מתוכנן</span></div><span>${fmt.format(new Date(x.confirmedAt))}</span></div>`).join("");
}
function showModal(dialog){
 if(!document.body.classList.contains("modal-locked")){lockedScrollY=window.scrollY;document.body.style.top=`-${lockedScrollY}px`;document.body.classList.add("modal-locked");}
 dialog.showModal();
}
function unlockModal(){
 if(document.querySelector("dialog[open]"))return;
 document.body.classList.remove("modal-locked");document.body.style.top="";
 window.scrollTo(0,lockedScrollY);
}
function showCalendar(open){
 el.editCalendar.classList.toggle("hidden",!open);
 el.editDateToggle.setAttribute("aria-expanded",String(open));
 if(open)renderCalendar();
}
function renderCalendar(){
 const year=calendarDate.getFullYear(),month=calendarDate.getMonth();
 el.calendarMonth.textContent=new Intl.DateTimeFormat("he-IL",{month:"long",year:"numeric"}).format(calendarDate);
 el.calendarGrid.replaceChildren();
 const first=new Date(year,month,1).getDay();
 for(let i=0;i<first;i++){const blank=document.createElement("span");blank.className="calendar-blank";el.calendarGrid.appendChild(blank);}
 const days=new Date(year,month+1,0).getDate();
 for(let day=1;day<=days;day++){
  const date=isoLocal(new Date(year,month,day));
  const b=document.createElement("button");b.type="button";b.className="calendar-day"+(date===el.editNextDue.value?" selected":"")+(date===isoLocal(new Date())?" today":"");
  b.textContent=String(day);b.setAttribute("aria-label",formatDate(date));b.setAttribute("aria-pressed",String(date===el.editNextDue.value));
  b.addEventListener("click",()=>{el.editNextDue.value=date;el.editDateText.textContent=formatDate(date);showCalendar(false);});
  el.calendarGrid.appendChild(b);
 }
}
function timeSelect(select){
 if(select.options.length)return;
 for(let hour=0;hour<24;hour++)for(let minute=0;minute<60;minute+=15){
  const value=String(hour).padStart(2,"0")+":"+String(minute).padStart(2,"0");
  const option=document.createElement("option");option.value=value;option.textContent=value;select.appendChild(option);
 }
}
function renderReminderTimes(){
 el.injectionTimes.replaceChildren();
 draftPrefs.dayTimes.forEach((time,index)=>{
  const row=document.createElement("div");row.className="reminder-time-row";
  const sel=document.createElement("select");sel.className="compact-select";sel.setAttribute("aria-label","שעת תזכורת "+(index+1));timeSelect(sel);sel.value=time;
  sel.addEventListener("change",()=>{draftPrefs.dayTimes[index]=sel.value;});
  const del=document.createElement("button");del.type="button";del.className="remove-time";del.textContent="✕";del.setAttribute("aria-label","הסר תזכורת בשעה "+time);
  del.addEventListener("click",()=>{draftPrefs.dayTimes.splice(index,1);renderReminderTimes();});
  row.append(sel,del);el.injectionTimes.appendChild(row);
 });
 el.addInjectionTime.disabled=draftPrefs.dayTimes.length>=8;
 if(draftPrefs.dayTimes.length===0){const p=document.createElement("div");p.className="pref-hint";p.textContent="אין תזכורות ביום ההזרקה.";el.injectionTimes.appendChild(p);}
}
function openNotificationsEditor(){
 draftPrefs=normalizePrefs(state.notificationPrefs);
 el.eveEnabled.checked=draftPrefs.eve;el.purchaseEnabled.checked=draftPrefs.purchase;
 timeSelect(el.eveTime);timeSelect(el.purchaseTime);
 el.eveTime.value=draftPrefs.eveTime;el.purchaseTime.value=draftPrefs.purchaseTime;
 el.eveTime.disabled=!draftPrefs.eve;el.purchaseTime.disabled=!draftPrefs.purchase;
 renderReminderTimes();showModal(el.notificationDialog);
}
async function saveNotificationPrefs(){
 const newPrefs=normalizePrefs({...draftPrefs,eve:el.eveEnabled.checked,eveTime:el.eveTime.value,purchase:el.purchaseEnabled.checked,purchaseTime:el.purchaseTime.value});
 if(!navigator.onLine)return toast("שינוי התראות דורש חיבור לשרת. נסה שוב כשיש אינטרנט.");
 el.saveNotifications.disabled=true;
 try{
  await device("/notifications",{preferences:newPrefs});
  state.notificationPrefs=newPrefs;save();render();el.notificationDialog.close();
  toast("הגדרות ההתראות נשמרו ותוזמנו מחדש בשרת.");
 }catch{toast("שמירת ההתראות נכשלה; ההגדרות הקודמות נשמרו.");}
 finally{el.saveNotifications.disabled=false;}
}
function render(){
 const needInstall=ios()&&!standalone();
 el.openSettings.classList.toggle("hidden",needInstall||!state.configured);
 el.installGate.classList.toggle("hidden",!needInstall);
 el.setupView.classList.toggle("hidden",needInstall||state.configured);
 el.notificationSetup.classList.toggle("hidden",needInstall||!state.configured||state.notificationSetupSeen);
 el.homeView.classList.toggle("hidden",needInstall||!state.configured||!state.notificationSetupSeen);
 el.offlineBanner.classList.toggle("hidden",navigator.onLine);
 el.missingSidePanel.classList.toggle("hidden",!state.configured||!!state.nextInjectionSide);
 if(state.configured){
  const remaining=daysUntil(state.nextDueDate);
   el.gaugeDays.textContent=String(Math.abs(remaining));
   el.gaugeLabel.textContent=remaining<0?"ימי איחור":remaining===1?"יום":"ימים";
   el.dueGauge.setAttribute("aria-label",remaining<0?`איחור של ${-remaining} ימים בהזרקה`:`${remaining} ימים עד ההזרקה`);
   const progress=Math.max(0,Math.min(1,(14-remaining)/14));
   el.gaugeNeedle.style.transform=`rotate(${-118+progress*236}deg)`;
   const prefs=normalizePrefs(state.notificationPrefs),copies=[];
   if(prefs.eve)copies.push(`ערב קודם: ${prefs.eveTime}`);
   if(prefs.dayTimes.length)copies.push(`ביום ההזרקה: ${prefs.dayTimes.join(" · ")}`);
   if(prefs.purchase)copies.push(`תזכורת לחבילה: ${prefs.purchaseTime}`);
   el.scheduleCopy.textContent=copies.length?copies.join("  |  "):"כל ההתראות כבויות (ניתן לשנות בהגדרות)";
   el.nextDueDate.textContent=formatDate(state.nextDueDate);
  el.nextInjectionSide.textContent=sideLabel(state.nextInjectionSide);
  el.countdown.textContent=countdown(state.nextDueDate);
  el.countdown.classList.toggle("overdue",daysUntil(state.nextDueDate)<=0);
  el.doseText.textContent=`${state.dosesRemaining} זריקות זמינות`;
  el.doseDots.replaceChildren();
  for(let i=0;i<Math.max(2,Math.min(6,state.dosesRemaining));i++){const d=document.createElement("span");d.className="dose-dot "+(i<state.dosesRemaining?"filled":"");el.doseDots.appendChild(d);}
  el.packageEmpty.classList.toggle("hidden",state.dosesRemaining!==0&&!state.orderPending);
  el.packageEmpty.textContent=state.orderPending?(state.dosesRemaining===0?"החבילה הוזמנה — ממתינים להגעה":"חבילה חדשה בהזמנה"):"המלאי הסתיים — יש לרכוש חבילה";
  el.orderPackage.textContent=state.orderPending?"בטל סימון הזמנה":"הזמנתי חבילה";
  el.confirmInjection.disabled=!dueNow()||state.dosesRemaining<=0;
  el.confirmHint.classList.toggle("hidden",dueNow()&&state.dosesRemaining>0);
  el.confirmHint.textContent=state.dosesRemaining<=0?"המלאי ריק. עדכן את המלאי אחרי קבלת חבילה.":"ניתן לאשר החל מיום ההזרקה המתוכנן.";
  renderHistory();
 }
 notifyStatus();
}
async function configure(){
 const anchorDate=el.anchorDate.value;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate))return toast("בחר תאריך הזרקה.");
 if(parseDate(anchorDate)>new Date())return toast("לא ניתן לבחור תאריך עתידי.");
 if(!selectedSide)return toast("בחר באיזו ירך בוצעה ההזרקה האחרונה.");
 state.configured=true;state.anchorDate=anchorDate;state.nextDueDate=addDays(anchorDate,14);state.lastInjectionSide=selectedSide;state.nextInjectionSide=oppositeSide(selectedSide);state.dosesRemaining=selectedDose;state.history=[];state.notificationSetupSeen=false;
 save();render();
 try{await device("/configure",{anchorDate,timeZone:timezone(),lastInjectionSide:selectedSide,dosesRemaining:selectedDose},"POST",true);}
 catch{toast("ההגדרה נשמרה. חיבור ההתראות יסתנכרן כשיהיה אינטרנט.");}
}
async function confirmInjection(){
 if(!dueNow())return;
 if(!state.nextInjectionSide)return toast("יש להשלים קודם את צד ההזרקה האחרונה.");
 const dueDate=state.nextDueDate,confirmedAt=new Date().toISOString(),injectionSide=state.nextInjectionSide;
 state.history.push({scheduledDate:dueDate,confirmedAt,injectionSide});
 state.dosesRemaining=Math.max(0,state.dosesRemaining-1);
 state.nextDueDate=addDays(dueDate,14);state.lastInjectionSide=injectionSide;state.nextInjectionSide=oppositeSide(injectionSide);
 save();render();
 try{await device("/confirm",{dueDate,confirmedAt,injectionSide,packageDepleted:state.dosesRemaining===0},"POST",true);toast("ההזרקה נרשמה והתזכורות העתידיות למועד זה בוטלו.");}
 catch{toast("ההזרקה נשמרה במכשיר. התראות בשרת יבוטלו לאחר חזרת החיבור.");}
}
async function purchased(){
 state.dosesRemaining=Math.min(40,state.dosesRemaining+2);state.orderPending=false;save();render();
 try{await device("/purchased",{},"POST",true);toast("שתי זריקות נוספו למלאי. תזכורת הרכישה בוטלה.");}
 catch{toast("נשמר במכשיר ויסתנכרן כשיהיה אינטרנט.");}
}
async function toggleOrder(){
 const pending=!state.orderPending;
 state.orderPending=pending;save();render();
 try{
  await device(pending?"/ordered":"/cancel-order",{},"POST",true);
  toast(pending?"ההזמנה נרשמה — לא יישלחו תזכורות רכישה בזמן ההמתנה.":"סימון ההזמנה בוטל.");
 }catch{toast("השינוי נשמר באייפון, אך לא סונכרן עדיין להתראות. בדוק חיבור לאינטרנט.");}
}
function openTrackingEditor(){
 el.editNextDue.value=state.nextDueDate;
 el.editNextSide.value=state.nextInjectionSide||"right";
 el.editStock.value=state.dosesRemaining;
 el.editOrderPending.checked=!!state.orderPending;
 calendarDate=parseDate(state.nextDueDate);el.editDateText.textContent=formatDate(state.nextDueDate);showCalendar(false);
 showModal(el.editTrackingDialog);
}
async function applyTrackingEdits(){
 const date=el.editNextDue.value,side=el.editNextSide.value,stock=Number(el.editStock.value),ordered=el.editOrderPending.checked;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||isoLocal(parseDate(date))!==date)return toast("בחר תאריך תקין.");
 if(side!=="left"&&side!=="right")return toast("בחר צד הזרקה.");
 if(!Number.isInteger(stock)||stock<0||stock>40)return toast("יש להזין מלאי בין 0 ל־40.");
 if(!navigator.onLine)return toast("עריכת המועד מחייבת חיבור לשרת ההתראות. נסה לאחר חיבור לאינטרנט.");
 const scheduleChanged=date!==state.nextDueDate||side!==state.nextInjectionSide;
 if(scheduleChanged&&!confirm("שינוי מועד או ירך ישנה את תזמון ההתראות העתידיות. ההיסטוריה לא תימחק. להמשיך?"))return;
 el.saveTrackingEdits.disabled=true;
 try{
  await device("/edit",{nextDueDate:date,nextSide:side,dosesRemaining:stock,orderPending:ordered},"POST");
  state.nextDueDate=date;state.nextInjectionSide=side;state.lastInjectionSide=oppositeSide(side);
  state.anchorDate=addDays(date,-14);state.dosesRemaining=stock;state.orderPending=ordered;
  save();render();el.editTrackingDialog.close();
  toast("הפרטים וההתראות העתידיות עודכנו. ההיסטוריה נשמרה.");
 }catch(err){toast("לא ניתן לשמור שינוי בלי לסנכרן התראות. נסה שוב כשהשרת זמין.");}
 finally{el.saveTrackingEdits.disabled=false;}
}
async function refreshTracking(){
 if(el.refreshTracking.disabled)return;
 el.refreshTracking.disabled=true;
 try{
  if(!navigator.onLine){render();toast("אין אינטרנט כרגע. ניתן לסנכרן כשיש חיבור.");return;}
  await flush();
  if("serviceWorker" in navigator)await navigator.serviceWorker.getRegistration("./").then(reg=>reg?.update()).catch(()=>null);
  if("Notification"in window&&Notification.permission==="granted"){try{await subscribe(false);}catch{}}
  render();
  toast("רועננו הנתונים המקומיים וסנכרון ההתראות נבדק.");
 }finally{el.refreshTracking.disabled=false;}
}
async function reset(){
 if(!confirm("למחוק את כל הנתונים ולהתחיל מחדש?"))return;
 try{await device("/reset",undefined,"DELETE");}catch{}
 localStorage.removeItem(STATE_KEY);localStorage.removeItem(QUEUE_KEY);state=defaults();selectedDose=2;selectedSide=null;save();render();
}
function bind(){
 const chooseSide=button=>{selectedSide=button.dataset.side;document.querySelectorAll(".side-choice,.side-fix-choice").forEach(b=>b.classList.toggle("selected",b.dataset.side===selectedSide));};
 document.querySelectorAll(".side-choice,.side-fix-choice").forEach(button=>button.addEventListener("click",()=>chooseSide(button)));
 document.querySelectorAll(".dose-choice").forEach(button=>button.addEventListener("click",()=>{selectedDose=Number(button.dataset.dose);document.querySelectorAll(".dose-choice").forEach(b=>b.classList.toggle("selected",b===button));}));
 el.recheckInstall.addEventListener("click",()=>location.reload());
 el.saveSetup.addEventListener("click",configure);
 el.saveMissingSide.addEventListener("click",async()=>{
  if(!selectedSide)return toast("בחר ירך ימין או ירך שמאל.");
  state.lastInjectionSide=selectedSide;state.nextInjectionSide=oppositeSide(selectedSide);save();render();
  try{await device("/side",{lastInjectionSide:selectedSide},"POST",true);toast("הרוטציה נשמרה. ההזרקה הבאה תהיה ב"+sideLabel(state.nextInjectionSide)+".");}
  catch{toast("הרוטציה נשמרה במכשיר ותסתנכרן עם שרת ההתראות.");}
 });
 el.skipNotifications.addEventListener("click",()=>{state.notificationSetupSeen=true;save();render();});
 el.enableNotifications.addEventListener("click",async()=>{
  el.enableNotifications.disabled=true;
  try{await subscribe(true);state.notificationSetupSeen=true;save();render();toast("ההתראות הופעלו.");}
  catch(e){toast(e.message==="denied"?"יש לאפשר התראות בהגדרות iPhone.":e.message==="backend_unavailable"?"האפליקציה מוכנה; שרת ההתראות יחובר בשלב הבא.":"הפעלת ההתראות נכשלה. בדוק חיבור והרשאות.");}
  finally{el.enableNotifications.disabled=false;}
 });
 el.pushWarning.addEventListener("click",async()=>{try{await subscribe(true);toast("ההתראות הופעלו.");}catch{toast("לא ניתן להפעיל התראות כעת.");}render();});
 el.confirmInjection.addEventListener("click",()=>{if(!state.nextInjectionSide)return toast("יש להשלים קודם את צד ההזרקה האחרונה.");el.confirmDialogText.textContent=`האישור יתייחס למועד המתוכנן ${formatDate(state.nextDueDate)}, ${sideLabel(state.nextInjectionSide)}. ההזרקה הבאה תישאר 14 יום לאחר המועד המתוכנן הזה ובצד ההפוך.`;showModal(el.confirmDialog);});
 el.dialogConfirmInjection.addEventListener("click",e=>{e.preventDefault();el.confirmDialog.close();confirmInjection();});
 [el.settingsDrawer,el.confirmDialog,el.packageDialog,el.editTrackingDialog,el.notificationDialog].forEach(d=>d.addEventListener("close",unlockModal));
 el.openSettings.addEventListener("click",()=>showModal(el.settingsDrawer));
 el.closeSettings.addEventListener("click",()=>el.settingsDrawer.close());
 el.manageNotifications.addEventListener("click",()=>{el.settingsDrawer.close();openNotificationsEditor();});
 el.eveEnabled.addEventListener("change",()=>{el.eveTime.disabled=!el.eveEnabled.checked;});
 el.purchaseEnabled.addEventListener("change",()=>{el.purchaseTime.disabled=!el.purchaseEnabled.checked;});
 el.addInjectionTime.addEventListener("click",()=>{
  if(draftPrefs.dayTimes.length>=8)return;
  const options=Array.from({length:96},(_,i)=>String(Math.floor(i/4)).padStart(2,"0")+":"+String((i%4)*15).padStart(2,"0"));
  draftPrefs.dayTimes.push(options.find(t=>!draftPrefs.dayTimes.includes(t)&&t>"09:45")||options.find(t=>!draftPrefs.dayTimes.includes(t))||"10:00");renderReminderTimes();
 });
 el.saveNotifications.addEventListener("click",saveNotificationPrefs);
 el.editDateToggle.addEventListener("click",()=>showCalendar(el.editCalendar.classList.contains("hidden")));
 el.calendarPrev.addEventListener("click",()=>{calendarDate=new Date(calendarDate.getFullYear(),calendarDate.getMonth()-1,1);renderCalendar();});
 el.calendarNext.addEventListener("click",()=>{calendarDate=new Date(calendarDate.getFullYear(),calendarDate.getMonth()+1,1);renderCalendar();});
 el.orderPackage.addEventListener("click",toggleOrder);
 el.editTracking.addEventListener("click",()=>{el.settingsDrawer.close();openTrackingEditor();});
 el.saveTrackingEdits.addEventListener("click",e=>{e.preventDefault();applyTrackingEdits();});
 el.refreshTracking.addEventListener("click",refreshTracking);
 el.newPackage.addEventListener("click",()=>showModal(el.packageDialog));
 el.dialogConfirmPackage.addEventListener("click",e=>{e.preventDefault();el.packageDialog.close();purchased();});
 el.resetApp.addEventListener("click",reset);
 window.addEventListener("online",async()=>{render();await flush();if("Notification" in window&&Notification.permission==="granted"){try{await subscribe(false);}catch{}}render();});
 window.addEventListener("offline",render);
 document.addEventListener("visibilitychange",()=>{if(!document.hidden)render();});
 document.addEventListener("touchstart",e=>{
  if(pullBusy||window.scrollY>1||document.querySelector("dialog[open]")||el.homeView.classList.contains("hidden")||e.touches.length!==1){pullStartY=null;return;}
  pullStartY=e.touches[0].clientY;pullDistance=0;
 },{passive:true});
 document.addEventListener("touchmove",e=>{
  if(pullStartY===null||e.touches.length!==1)return;
  const dy=e.touches[0].clientY-pullStartY;
  if(dy<=0||window.scrollY>1){pullDistance=0;el.pullIndicator.classList.remove("visible");return;}
  pullDistance=Math.min(130,dy);
  if(pullDistance>18){el.pullIndicator.classList.add("visible");el.pullText.textContent=pullDistance>=85?"שחרר לריענון":"משוך לריענון";}
 },{passive:true});
 document.addEventListener("touchend",async()=>{
  if(pullStartY===null)return;
  const shouldRefresh=pullDistance>=85;pullStartY=null;pullDistance=0;
  if(!shouldRefresh){el.pullIndicator.classList.remove("visible");return;}
  pullBusy=true;el.pullIndicator.classList.add("loading","visible");el.pullText.textContent="מסנכרן…";
  try{await refreshTracking();}finally{pullBusy=false;el.pullIndicator.classList.remove("visible","loading");}
 },{passive:true});
 document.addEventListener("touchcancel",()=>{pullStartY=null;pullDistance=0;if(!pullBusy)el.pullIndicator.classList.remove("visible");},{passive:true});
}
async function boot(){
 bind();el.anchorDate.value=isoLocal(new Date());
 await registerServiceWorker().catch(()=>null);
 render();await flush();
 if(state.configured&&"Notification" in window&&Notification.permission==="granted"&&(!ios()||standalone())){try{await subscribe(false);}catch{state.pushSynced=false;save();}}
 render();
}
boot();