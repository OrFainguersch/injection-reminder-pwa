import { DateTime } from "luxon";
import { generateVapidKeys } from "@mmmike/web-push/vapid";
import { sendPushNotification } from "@mmmike/web-push/send";

const json = (value, status=200) => new Response(JSON.stringify(value), {status,headers:{"content-type":"application/json;charset=utf-8","cache-control":"no-store"}});
const HOURS=[10,14,18,22];
const DEFAULT_FRONTEND_ORIGIN="https://orfainguersch.github.io";
const corsOrigin=(request,env)=>{const origin=String(request.headers.get("origin")||"");const configured=String(env.FRONTEND_ORIGIN||DEFAULT_FRONTEND_ORIGIN).trim();return origin&&origin===configured?origin:"";};
const cors=(response,request,env)=>{const headers=new Headers(response.headers);const origin=corsOrigin(request,env);if(origin){headers.set("access-control-allow-origin",origin);headers.set("vary","Origin");}headers.set("access-control-allow-methods","GET,POST,DELETE,OPTIONS");headers.set("access-control-allow-headers","content-type");return new Response(response.body,{status:response.status,statusText:response.statusText,headers});};
const deviceIdOK=s=>typeof s==="string" && /^[a-f0-9-]{32,64}$/i.test(s);
const safeSubscription=s=>{try{const u=new URL(s?.endpoint||"");return u.protocol==="https:"&&(u.hostname==="push.apple.com"||u.hostname.endsWith(".push.apple.com")) && !!s?.keys?.auth && !!s?.keys?.p256dh;}catch{return false;}};
const defaultState=()=>({subscription:null,anchorDate:null,anchorSide:null,timeZone:"Asia/Jerusalem",confirmedDueDates:[],purchaseReminderAt:null});
const dueFor=(anchor,cycle,zone)=>DateTime.fromISO(anchor,{zone}).startOf("day").plus({days:14*(cycle+1)});
const validSide=side=>side==="right"||side==="left";
const sideForCycle=(anchorSide,cycle)=>!validSide(anchorSide)?null:(cycle%2===0?(anchorSide==="right"?"left":"right"):anchorSide);
const sideHe=side=>side==="right"?"ירך ימין":side==="left"?"ירך שמאל":"";
const buyReminder=(iso,zone)=>{let d=DateTime.fromISO(iso,{zone}).startOf("day").plus({days:1}).set({hour:10});if(d.weekday===6)d=d.plus({days:1});return d.toUTC().toISO();};

export class PushConfig {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async keys(){
    let keys=await this.ctx.storage.get("vapid");
    if(!keys){keys=await generateVapidKeys();await this.ctx.storage.put("vapid",keys);}
    return keys;
  }
  async fetch(request){
    const keys=await this.keys();
    return new URL(request.url).pathname==="/private" ? json(keys) : json({publicKey:keys.publicKey});
  }
}

export class ReminderDevice {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async state(){return await this.ctx.storage.get("state")||defaultState();}
  async put(state){await this.ctx.storage.put("state",state);}
  async vapid(){
    const stub=this.env.PUSH_CONFIG.get(this.env.PUSH_CONFIG.idFromName("global"));
    const r=await stub.fetch("https://internal/private");
    const k=await r.json();
    return {...k,subject:"https://example.com"};
  }
  async send(subscription,payload){return sendPushNotification(subscription,payload,await this.vapid(),{ttl:86400,urgency:"high"});}
  eventPayload(event){
    if(event.kind==="purchase")return {title:"החבילה הסתיימה",body:"השתמשת בזריקה השנייה בחבילה. הגיע הזמן לרכוש חבילה חדשה.",url:"",tag:"package-purchase"};
    const side=sideHe(event.side),suffix=side?` הפעם: ${side}.`:"";
    if(event.kind==="eve")return {title:"תזכורת להזרקה",body:"מחר יום ההזרקה שלך."+suffix,url:"",tag:"eve-"+event.dueDate};
    return {title:"הגיע הזמן להזריק",body:"היום הוא יום ההזרקה."+suffix+" היכנס לאפליקציה ואשר לאחר שהזרקת.",url:"",tag:"due-"+event.dueDate};
  }
  nextEvent(state,after=Date.now()){
    const events=[];
    if(state.purchaseReminderAt){const ms=Date.parse(state.purchaseReminderAt);if(ms>after)events.push({kind:"purchase",at:ms});}
    if(state.anchorDate){
      const zone=state.timeZone||"Asia/Jerusalem";
      const today=DateTime.fromMillis(after,{zone}).startOf("day");
      const anchor=DateTime.fromISO(state.anchorDate,{zone}).startOf("day");
      const days=Math.max(0,Math.floor(today.diff(anchor,"days").days));
      const start=Math.max(0,Math.floor(days/14)-1);
      const confirmed=new Set(state.confirmedDueDates||[]);
      for(let cycle=start;cycle<start+8;cycle++){
        const due=dueFor(state.anchorDate,cycle,zone),key=due.toISODate();
        if(confirmed.has(key))continue;
        const eve=due.minus({days:1}).set({hour:20,minute:0,second:0,millisecond:0}).toMillis();
        const side=sideForCycle(state.anchorSide,cycle);
        if(eve>after)events.push({kind:"eve",at:eve,dueDate:key,side});
        for(const hour of HOURS){
          const at=due.set({hour,minute:0,second:0,millisecond:0}).toMillis();
          if(at>after)events.push({kind:"injection",at,dueDate:key,side});
        }
      }
    }
    events.sort((a,b)=>a.at-b.at);
    return events[0]||null;
  }
  async schedule(after=Date.now()){
    const s=await this.state();
    if(!s.subscription){await this.ctx.storage.deleteAlarm();await this.ctx.storage.delete("scheduledEvent");return;}
    const e=this.nextEvent(s,after);
    if(!e){await this.ctx.storage.deleteAlarm();await this.ctx.storage.delete("scheduledEvent");return;}
    await this.ctx.storage.put("scheduledEvent",e);
    await this.ctx.storage.setAlarm(e.at);
  }
  async alarm(){
    const s=await this.state(),e=await this.ctx.storage.get("scheduledEvent");
    if(!e){await this.schedule();return;}
    if(e.kind==="purchase")s.purchaseReminderAt=null;
    if(s.subscription){
      try{const ok=await this.send(s.subscription,this.eventPayload(e));if(!ok)s.subscription=null;}
      catch(error){console.error("Push delivery failed",String(error));}
    }
    await this.put(s);
    await this.schedule(Date.now()+1500);
  }
  async fetch(request){
    const p=new URL(request.url).pathname,m=request.method;
    if(m==="GET"&&p==="/status"){const s=await this.state();return json({configured:!!s.anchorDate,subscribed:!!s.subscription});}
    if(m==="POST"&&p==="/subscription"){
      const b=await request.json().catch(()=>({}));
      if(!safeSubscription(b.subscription))return json({error:"invalid_subscription"},400);
      const s=await this.state();s.subscription=b.subscription;await this.put(s);await this.schedule();return json({ok:true});
    }
    if(m==="POST"&&p==="/configure"){
      const b=await request.json().catch(()=>({}));
      const zone=typeof b.timeZone==="string"&&b.timeZone.length<80?b.timeZone:"Asia/Jerusalem";
      if(!/^\d{4}-\d{2}-\d{2}$/.test(b.anchorDate||"")||!DateTime.fromISO(b.anchorDate,{zone}).isValid)return json({error:"invalid_date"},400);
      const s=await this.state();s.anchorDate=b.anchorDate;s.anchorSide=validSide(b.lastInjectionSide)?b.lastInjectionSide:null;s.timeZone=zone;s.confirmedDueDates=[];s.purchaseReminderAt=null;
      await this.put(s);await this.schedule();return json({ok:true});
    }
    if(m==="POST"&&p==="/side"){
      const b=await request.json().catch(()=>({}));if(!validSide(b.lastInjectionSide))return json({error:"invalid_side"},400);
      const s=await this.state();if(!s.anchorDate)return json({error:"not_configured"},409);s.anchorSide=b.lastInjectionSide;await this.put(s);await this.schedule();return json({ok:true});
    }
    if(m==="POST"&&p==="/confirm"){
      const b=await request.json().catch(()=>({})),s=await this.state();
      if(!s.anchorDate)return json({error:"not_configured"},409);
      if(typeof b.dueDate!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate))return json({error:"invalid_due"},400);
      s.confirmedDueDates=[...new Set([...(s.confirmedDueDates||[]),b.dueDate])].slice(-80);
      if(b.packageDepleted===true){
        const stamp=typeof b.confirmedAt==="string"&&DateTime.fromISO(b.confirmedAt).isValid?b.confirmedAt:DateTime.now().toISO();
        s.purchaseReminderAt=buyReminder(stamp,s.timeZone||"Asia/Jerusalem");
      }
      await this.put(s);await this.schedule();return json({ok:true});
    }
    if(m==="POST"&&p==="/purchased"){
      const s=await this.state();s.purchaseReminderAt=null;await this.put(s);await this.schedule();return json({ok:true});
    }
    if(m==="POST"&&p==="/test"){
      const s=await this.state();if(!s.subscription)return json({error:"not_subscribed"},409);
      try{return json({ok:await this.send(s.subscription,{title:"בדיקת התראה",body:"ההתראות של תזכורת ההזרקה פועלות.",url:"",tag:"push-test"})});}
      catch(e){console.error(String(e));return json({error:"push_failed"},502);}
    }
    if(m==="DELETE"&&p==="/reset"){await this.ctx.storage.deleteAll();await this.ctx.storage.deleteAlarm();return json({ok:true});}
    return json({error:"not_found"},404);
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname.startsWith("/api/")&&request.method==="OPTIONS")return cors(new Response(null,{status:204}),request,env);
    if(request.method==="GET"&&url.pathname==="/api/config"){
      const stub=env.PUSH_CONFIG.get(env.PUSH_CONFIG.idFromName("global"));
      return cors(await stub.fetch("https://internal/keys"),request,env);
    }
    const m=url.pathname.match(/^\/api\/device\/([^/]+)(\/.*)$/);
    if(m){
      const id=decodeURIComponent(m[1]);if(!deviceIdOK(id))return cors(json({error:"invalid_device_id"},400),request,env);
      const stub=env.REMINDER_DEVICE.get(env.REMINDER_DEVICE.idFromName(id));
      const target=new URL(request.url);target.pathname=m[2];
      return cors(await stub.fetch(new Request(target,request)),request,env);
    }
    return env.ASSETS.fetch(request);
  }
};