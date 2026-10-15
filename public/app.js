const STATE_KEY="injectionReminder.state.v2",QUEUE_KEY="injectionReminder.queue.v2";\nconst API_BASE_URL=String(window.INJECTION_REMINDER_CONFIG?.apiBaseUrl||"").replace(/\\/$/,"");
const ids=["installGate","setupView","notificationSetup","homeView","statusPill","recheckInstall","anchorDate","saveSetup","enableNotifications","skipNotifications","countdown","nextDueDate","doseText","doseDots","packageEmpty","confirmInjection","confirmHint","newPackage","historyList","testNotification","resetApp","offlineBanner","pushWarning","toast","confirmDialog","confirmDialogText","dialogConfirmInjection","packageDialog","dialogConfirmPackage"];
const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
const defaults=()=>({configured:false,anchorDate:"",nextDueDate:"",dosesRemaining:2,history:[],deviceId:crypto.randomUUID(),notificationSetupSeen:false,pushSynced:false});
function load(){try{return {...defaults(),...(JSON.parse(localStorage.getItem(STATE_KEY))||{})};}catch{return defaults();}}
let state=load(),selectedDose=2,toastTimer;
const save=()=>localStorage.setItem(STATE_KEY,JSON.stringify(state));
const isoLocal=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-");
const parseDate=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d,12);};
const addDays=(s,n)=>{const d=parseDate(s);d.setDate(d.getDate()+n);return isoLocal(d);};
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
  if(!API_BASE_URL)throw Error("backend_unavailable");\n  const response=await fetch(`${API_BASE_URL}/api/device/${encodeURIComponent(state.deviceId)}${path}`,{method,headers:body===undefined?undefined:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
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
async function subscribe(userGesture=false){
 if(ios()&&!standalone())throw Error("install_required");
 if(!("Notification" in window)||!("PushManager" in window))throw Error("unsupported");
 if(Notification.permission==="denied")throw Error("denied");
 // Ask before the first await so iOS recognizes the user interaction.
 let permission=Notification.permission;
 if(permission==="default"&&userGesture)permission=await Notification.requestPermission();
 if(permission!=="granted")throw Error("permission_required");
 const registration=await registerServiceWorker();
 if(!API_BASE_URL)throw Error("backend_unavailable");\n const response=await fetch(`${API_BASE_URL}/api/config`,{cache:"no-store"});
 if(!response.ok)throw Error("config_failed");
 const {publicKey,vapidPublicKey}=await response.json();
 const key=publicKey||vapidPublicKey;
 let subscription=await registration.pushManager.getSubscription();
 if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeKey(key)});
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
 el.historyList.innerHTML=state.history.slice().reverse().map(x=>`<div class="history-item"><div><strong>${formatDate(x.scheduledDate)}</strong><br><span>מועד מתוכנן</span></div><span>${fmt.format(new Date(x.confirmedAt))}</span></div>`).join("");
}
function render(){
 const needInstall=ios()&&!standalone();
 el.installGate.classList.toggle("hidden",!needInstall);
 el.setupView.classList.toggle("hidden",needInstall||state.configured);
 el.notificationSetup.classList.toggle("hidden",needInstall||!state.configured||state.notificationSetupSeen);
 el.homeView.classList.toggle("hidden",needInstall||!state.configured||!state.notificationSetupSeen);
 el.offlineBanner.classList.toggle("hidden",navigator.onLine);
 if(state.configured){
  el.nextDueDate.textContent=formatDate(state.nextDueDate);
  el.countdown.textContent=countdown(state.nextDueDate);
  el.countdown.classList.toggle("overdue",daysUntil(state.nextDueDate)<=0);
  el.doseText.textContent=`${state.dosesRemaining} מתוך 2`;
  el.doseDots.replaceChildren();
  for(let i=0;i<2;i++){const d=document.createElement("span");d.className="dose-dot "+(i<state.dosesRemaining?"filled":"");el.doseDots.appendChild(d);}
  el.packageEmpty.classList.toggle("hidden",state.dosesRemaining!==0);
  el.confirmInjection.disabled=!dueNow();
  el.confirmHint.classList.toggle("hidden",dueNow());
  renderHistory();
 }
 notifyStatus();
}
async function configure(){
 const anchorDate=el.anchorDate.value;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate))return toast("בחר תאריך הזרקה.");
 if(parseDate(anchorDate)>new Date())return toast("לא ניתן לבחור תאריך עתידי.");
 state.configured=true;state.anchorDate=anchorDate;state.nextDueDate=addDays(anchorDate,14);state.dosesRemaining=selectedDose;state.history=[];state.notificationSetupSeen=false;
 save();render();
 try{await device("/configure",{anchorDate,timeZone:timezone()},"POST",true);}
 catch{toast("ההגדרה נשמרה. חיבור ההתראות יסתנכרן כשיהיה אינטרנט.");}
}
async function confirmInjection(){
 if(!dueNow())return;
 const dueDate=state.nextDueDate,confirmedAt=new Date().toISOString();
 state.history.push({scheduledDate:dueDate,confirmedAt});
 state.dosesRemaining=Math.max(0,state.dosesRemaining-1);
 state.nextDueDate=addDays(dueDate,14);
 save();render();
 try{await device("/confirm",{dueDate,confirmedAt,packageDepleted:state.dosesRemaining===0},"POST",true);toast("ההזרקה נרשמה והתזכורות העתידיות למועד זה בוטלו.");}
 catch{toast("ההזרקה נשמרה במכשיר. התראות בשרת יבוטלו לאחר חזרת החיבור.");}
}
async function purchased(){
 state.dosesRemaining=2;save();render();
 try{await device("/purchased",{},"POST",true);toast("מונה החבילה אופס ל־2 זריקות.");}
 catch{toast("נשמר במכשיר ויסתנכרן כשיהיה אינטרנט.");}
}
async function reset(){
 if(!confirm("למחוק את כל הנתונים ולהתחיל מחדש?"))return;
 try{await device("/reset",undefined,"DELETE");}catch{toast("איפוס השרת נכשל; ודא שהחיבור לאינטרנט פעיל לפני מחיקת ההגדרות.");return;}
 localStorage.removeItem(STATE_KEY);localStorage.removeItem(QUEUE_KEY);state=defaults();selectedDose=2;save();render();
}
function bind(){
 document.querySelectorAll(".dose-choice").forEach(button=>button.addEventListener("click",()=>{selectedDose=Number(button.dataset.dose);document.querySelectorAll(".dose-choice").forEach(b=>b.classList.toggle("selected",b===button));}));
 el.recheckInstall.addEventListener("click",()=>location.reload());
 el.saveSetup.addEventListener("click",configure);
 el.skipNotifications.addEventListener("click",()=>{state.notificationSetupSeen=true;save();render();});
 el.enableNotifications.addEventListener("click",async()=>{
  el.enableNotifications.disabled=true;
  try{await subscribe(true);state.notificationSetupSeen=true;save();render();toast("ההתראות הופעלו.");}
  catch(e){toast(e.message==="denied"?"יש לאפשר התראות בהגדרות iPhone.":e.message==="backend_unavailable"?"האפליקציה מוכנה; שרת ההתראות יחובר בשלב הבא.":"הפעלת ההתראות נכשלה. בדוק חיבור והרשאות.");}
  finally{el.enableNotifications.disabled=false;}
 });
 el.pushWarning.addEventListener("click",async()=>{try{await subscribe(true);toast("ההתראות הופעלו.");}catch{toast("לא ניתן להפעיל התראות כעת.");}render();});
 el.confirmInjection.addEventListener("click",()=>{el.confirmDialogText.textContent=`האישור יתייחס למועד המתוכנן ${formatDate(state.nextDueDate)}. ההזרקה הבאה תישאר 14 יום לאחר המועד המתוכנן הזה.`;el.confirmDialog.showModal();});
 el.dialogConfirmInjection.addEventListener("click",e=>{e.preventDefault();el.confirmDialog.close();confirmInjection();});
 el.newPackage.addEventListener("click",()=>el.packageDialog.showModal());
 el.dialogConfirmPackage.addEventListener("click",e=>{e.preventDefault();el.packageDialog.close();purchased();});
 el.testNotification.addEventListener("click",async()=>{try{await subscribe(true);const r=await device("/test",{});if(!r.ok)throw Error("not_sent");toast("נשלחה התראת בדיקה.");}catch{toast("הבדיקה נכשלה. בדוק הרשאות וחיבור לאינטרנט.");}render();});
 el.resetApp.addEventListener("click",reset);
 window.addEventListener("online",async()=>{render();await flush();if("Notification" in window&&Notification.permission==="granted"){try{await subscribe(false);}catch{}}render();});
 window.addEventListener("offline",render);
 document.addEventListener("visibilitychange",()=>{if(!document.hidden)render();});
}
async function boot(){
 bind();el.anchorDate.value=isoLocal(new Date());
 await registerServiceWorker().catch(()=>null);
 render();await flush();
 if(state.configured&&"Notification" in window&&Notification.permission==="granted"&&(!ios()||standalone())){try{await subscribe(false);}catch{state.pushSynced=false;save();}}
 render();
}
boot();