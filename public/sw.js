const CACHE="injection-reminder-v5";
const ROOT=new URL("./",self.location.href);
const asset=(path="")=>new URL(path,ROOT).href;
const SHELL=[asset(""),asset("styles.css"),asset("app.js"),asset("runtime-config.js"),asset("manifest.webmanifest"),asset("icons/icon.svg"),asset("icons/apple-touch-icon.png")];
self.addEventListener("install",event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
 self.skipWaiting();
});
self.addEventListener("activate",event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))));
 self.clients.claim();
});
self.addEventListener("fetch",event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=="GET"||url.origin!==self.location.origin)return;
 event.respondWith(fetch(event.request).then(response=>{
  if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));}
  return response;
 }).catch(()=>caches.match(event.request).then(cached=>cached||caches.match(asset("")))));
});
self.addEventListener("push",event=>{
 let payload={title:"תזכורת הזרקה",body:"יש לך תזכורת.",url:"",tag:"injection-reminder"};
 try{if(event.data)payload={...payload,...event.data.json()};}catch{}
 const target=payload.url?new URL(payload.url,self.registration.scope).href:self.registration.scope;
 event.waitUntil(self.registration.showNotification(payload.title,{body:payload.body,icon:asset("icons/apple-touch-icon.png"),badge:asset("icons/apple-touch-icon.png"),tag:payload.tag,data:{url:target},silent:false}));
});
self.addEventListener("notificationclick",event=>{
 event.notification.close();
 const url=event.notification.data?.url||self.registration.scope;
 event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(clients=>{
  const open=clients.find(client=>client.url===url||client.url.startsWith(self.registration.scope));
  return open?open.focus():self.clients.openWindow(url);
 }));
});
