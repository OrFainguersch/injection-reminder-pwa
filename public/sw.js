const CACHE="injection-reminder-v2";
const SHELL=["/","/styles.css","/app.js","/manifest.webmanifest","/icons/icon.svg"];
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
 if(event.request.method!=="GET"||url.pathname.startsWith("/api/"))return;
 event.respondWith(fetch(event.request).then(response=>{
  if(response.ok && url.origin===self.location.origin){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));}
  return response;
 }).catch(()=>caches.match(event.request).then(cached=>cached||caches.match("/"))));
});
self.addEventListener("push",event=>{
 let payload={title:"תזכורת הזרקה",body:"יש לך תזכורת.",url:"/",tag:"injection-reminder"};
 try{if(event.data)payload={...payload,...event.data.json()};}catch{}
 event.waitUntil(self.registration.showNotification(payload.title,{body:payload.body,icon:"/icons/icon.svg",badge:"/icons/icon.svg",tag:payload.tag,data:{url:payload.url||"/"},silent:false}));
});
self.addEventListener("notificationclick",event=>{
 event.notification.close();
 const url=event.notification.data?.url||"/";
 event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(clients=>{
  const open=clients.find(client=>new URL(client.url).pathname===new URL(url,self.location.origin).pathname);
  return open?open.focus():self.clients.openWindow(url);
 }));
});