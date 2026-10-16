import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { ReminderDevice } from "../src/worker.js";

function fakeState(initial = {}) {
  const db = new Map([["state", initial]]);
  const storage = {
    get: async key => db.get(key),
    put: async (key, value) => { db.set(key, value); },
    delete: async key => { db.delete(key); },
    deleteAlarm: async () => {},
    setAlarm: async () => {},
    deleteAll: async () => { db.clear(); }
  };
  return { db, device: new ReminderDevice({storage}, {}) };
}
const zone = "Asia/Jerusalem";
const stamp = (date, hour) => DateTime.fromISO(date,{zone}).startOf("day").set({hour}).toMillis();
const base = (anchorDate,anchorSide="right") => ({anchorDate,anchorSide,timeZone:zone,confirmedDueDates:[],purchaseReminderAt:null,subscription:{endpoint:"mock"}});

test("13 days after the last injection: reminder is at 20:00 the evening before",()=>{
 const {device}=fakeState();
 const event=device.nextEvent(base("2026-10-01"),stamp("2026-10-14",19));
 assert.equal(event.kind,"eve");
 assert.equal(event.dueDate,"2026-10-15");
 assert.equal(event.at,stamp("2026-10-14",20));
 assert.equal(event.side,"left");
});
test("day of injection schedules 10,14,18,22 (no later alarms that night)",()=>{
 const {device}=fakeState(),state=base("2026-10-01");
 for(const [from,expected] of [[9,10],[11,14],[15,18],[19,22]]){
   const e=device.nextEvent(state,stamp("2026-10-15",from));
   assert.equal(e.at,stamp("2026-10-15",expected));
 }
 const after=device.nextEvent(state,stamp("2026-10-15",23));
 assert.equal(after.kind,"eve");
 assert.equal(after.dueDate,"2026-10-29");
 assert.equal(after.side,"right");
});
test("confirmation skips current due date without shifting 14-day schedule",()=>{
 const {device}=fakeState();
 const state={...base("2026-10-01"),confirmedDueDates:["2026-10-15"]};
 const e=device.nextEvent(state,stamp("2026-10-15",11));
 assert.equal(e.kind,"eve");
 assert.equal(e.dueDate,"2026-10-29");
 assert.equal(e.at,stamp("2026-10-28",20));
});
test("Saturday purchase reminders move to Sunday morning",async()=>{
 const initial={...base("2026-10-01"),subscription:null};
 const {device,db}=fakeState(initial);
 const response=await device.fetch(new Request("https://internal/confirm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
  dueDate:"2026-10-15",confirmedAt:"2026-10-16T21:00:00+03:00",packageDepleted:true
 })}));
 assert.equal(response.status,200);
 assert.equal(db.get("state").purchaseReminderAt,DateTime.fromISO("2026-10-18T10:00:00",{zone}).toUTC().toISO());
});
test("confirmation without empty package does not set purchase reminder",async()=>{
 const initial={...base("2026-10-01"),subscription:null};
 const {device,db}=fakeState(initial);
 await device.fetch(new Request("https://internal/confirm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
  dueDate:"2026-10-15",confirmedAt:"2026-10-15T11:00:00+03:00",packageDepleted:false
 })}));
 assert.equal(db.get("state").purchaseReminderAt,null);
});

test("injection side alternates from the last recorded thigh",()=>{
 const {device}=fakeState(),state=base("2026-10-01","left");
 const first=device.nextEvent(state,stamp("2026-10-14",19));
 assert.equal(first.side,"right");
 const nextState={...state,confirmedDueDates:["2026-10-15"]};
 const second=device.nextEvent(nextState,stamp("2026-10-15",23));
 assert.equal(second.dueDate,"2026-10-29");
 assert.equal(second.side,"left");
});
test("side completion updates an existing configured schedule without resetting it",async()=>{
 const initial={...base("2026-10-01",null),subscription:null,confirmedDueDates:["2026-10-15"],purchaseReminderAt:"2026-10-20T07:00:00.000Z"};
 const {device,db}=fakeState(initial);
 const response=await device.fetch(new Request("https://internal/side",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({lastInjectionSide:"right"})}));
 assert.equal(response.status,200);
 assert.equal(db.get("state").anchorSide,"right");
 assert.deepEqual(db.get("state").confirmedDueDates,["2026-10-15"]);
 assert.equal(db.get("state").purchaseReminderAt,"2026-10-20T07:00:00.000Z");
});
test("push copy includes the scheduled thigh and purchase copy remains separate",()=>{
 const {device}=fakeState();
 assert.match(device.eventPayload({kind:"eve",dueDate:"2026-10-15",side:"left"}).body,/ירך שמאל/);
 assert.match(device.eventPayload({kind:"injection",dueDate:"2026-10-15",side:"right"}).body,/ירך ימין/);
 assert.match(device.eventPayload({kind:"purchase"}).body,/לרכוש חבילה חדשה/);
});

test("delayed test schedules a real server-side alarm without changing medical schedule",async()=>{
 const initial={...base("2026-10-01"),testReminderAt:null};
 const {device,db}=fakeState(initial);
 const response=await device.fetch(new Request("https://internal/test-delayed",{method:"POST"}));
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.delaySeconds,60);
 const saved=db.get("state");
 assert.equal(saved.anchorDate,"2026-10-01");
 assert.equal(saved.anchorSide,"right");
 assert.equal(saved.confirmedDueDates.length,0);
 const event=device.nextEvent(saved,Date.now());
 assert.equal(event.kind,"test");
 assert.ok(event.at>Date.now()+49000 && event.at<Date.now()+71000);
 assert.match(device.eventPayload(event).body,/Push/);
});
test("delayed test requires an existing push subscription",async()=>{
 const {device}=fakeState({...base("2026-10-01"),subscription:null});
 const response=await device.fetch(new Request("https://internal/test-delayed",{method:"POST"}));
 assert.equal(response.status,409);
});

test("editing next injection reanchors its date/side without clearing inventory workflow",async()=>{
 const {device,db}=fakeState({...base("2026-10-01"),confirmedDueDates:["2026-10-15"],subscription:null});
 const req=new Request("https://internal/edit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({nextDueDate:"2026-10-31",nextSide:"right",dosesRemaining:3,orderPending:false})});
 const response=await device.fetch(req);
 assert.equal(response.status,200);
 const s=db.get("state");
 assert.equal(s.anchorDate,"2026-10-17");
 assert.equal(s.anchorSide,"left");
 assert.deepEqual(s.confirmedDueDates,[]);
 const event=device.nextEvent(s,stamp("2026-10-30",19));
 assert.equal(event.kind,"eve");assert.equal(event.side,"right");
});
test("ordering stops purchase reminder, receipt and cancellation are independent of the dose cycle",async()=>{
 const {device,db}=fakeState({...base("2026-10-01"),subscription:null,isDepleted:true,purchaseReminderAt:"2026-10-20T07:00:00.000Z"});
 async function post(name){return device.fetch(new Request("https://internal/"+name,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}));}
 assert.equal((await post("ordered")).status,200);
 assert.equal(db.get("state").orderPending,true);
 assert.equal(db.get("state").purchaseReminderAt,null);
 assert.equal((await post("cancel-order")).status,200);
 assert.equal(db.get("state").orderPending,false);
 assert.ok(db.get("state").purchaseReminderAt);
 assert.equal((await post("purchased")).status,200);
 assert.equal(db.get("state").purchaseReminderAt,null);
 assert.equal(db.get("state").isDepleted,false);
});


test("custom evening and injection-day times are used by the real scheduler",()=>{
 const {device}=fakeState();
 const s={...base("2026-10-01"),notificationPreferences:{eve:true,eveTime:"19:15",dayTimes:["09:30","16:45"],purchase:true,purchaseTime:"11:15"}};
 assert.equal(device.nextEvent(s,stamp("2026-10-14",19)).at,stamp("2026-10-14",19)+15*60*1000);
 assert.equal(device.nextEvent(s,stamp("2026-10-14",20)).at,stamp("2026-10-15",9)+30*60*1000);
 assert.equal(device.nextEvent(s,stamp("2026-10-15",10)).at,stamp("2026-10-15",16)+45*60*1000);
});
test("disabled evening and injection alerts leave the purchase workflow unaffected",()=>{
 const {device}=fakeState();
 const s={...base("2026-10-01"),notificationPreferences:{eve:false,eveTime:"20:00",dayTimes:[],purchase:true,purchaseTime:"10:00"},purchaseReminderAt:DateTime.fromISO("2026-10-17T10:00:00",{zone}).toUTC().toISO()};
 const e=device.nextEvent(s,stamp("2026-10-15",9));
 assert.equal(e.kind,"purchase");
 assert.equal(e.at,stamp("2026-10-17",10));
});
test("changing notification settings reschedules without modifying injection history or anchor",async()=>{
 const initial={...base("2026-10-01"),confirmedDueDates:["2026-10-15"],subscription:null};
 const {device,db}=fakeState(initial);
 const preferences={eve:false,eveTime:"18:00",dayTimes:["08:15"],purchase:false,purchaseTime:"13:30"};
 const response=await device.fetch(new Request("https://internal/notifications",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({preferences})}));
 assert.equal(response.status,200);
 const s=db.get("state");
 assert.equal(s.anchorDate,"2026-10-01");assert.deepEqual(s.confirmedDueDates,["2026-10-15"]);
 assert.deepEqual(s.notificationPreferences,preferences);
 const e=device.nextEvent(s,stamp("2026-10-28",19));
 assert.equal(e.kind,"injection");assert.equal(e.at,stamp("2026-10-29",8)+15*60*1000);
});
test("invalid notification settings are rejected without mutation",async()=>{
 const initial=base("2026-10-01");const {device,db}=fakeState(initial);
 const response=await device.fetch(new Request("https://internal/notifications",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({preferences:{eve:true,eveTime:"25:30",dayTimes:["10:00"],purchase:true,purchaseTime:"10:00"}})}));
 assert.equal(response.status,400);
 assert.equal(db.get("state").notificationPreferences,undefined);
});
test("purchase reminder time obeys the user's preferences",async()=>{
 const initial={...base("2026-10-01"),subscription:null,notificationPreferences:{eve:true,eveTime:"20:00",dayTimes:["10:00"],purchase:true,purchaseTime:"13:45"}};
 const {device,db}=fakeState(initial);
 const response=await device.fetch(new Request("https://internal/confirm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({dueDate:"2026-10-15",confirmedAt:"2026-10-16T21:00:00+03:00",packageDepleted:true})}));
 assert.equal(response.status,200);
 assert.equal(db.get("state").purchaseReminderAt,DateTime.fromISO("2026-10-18T13:45:00",{zone}).toUTC().toISO());
});


test("inventory edit preserves the date cycle, sides and previously confirmed injections",async()=>{
 const initial={...base("2026-10-01"),confirmedDueDates:["2026-10-15"],isDepleted:false,subscription:null};
 const {device,db}=fakeState(initial);
 const response=await device.fetch(new Request("https://internal/inventory",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({dosesRemaining:1,orderPending:false})}));
 assert.equal(response.status,200);
 const saved=db.get("state");
 assert.equal(saved.anchorDate,"2026-10-01");
 assert.equal(saved.anchorSide,"right");
 assert.deepEqual(saved.confirmedDueDates,["2026-10-15"]);
 assert.equal(saved.isDepleted,false);
 const next=device.nextEvent(saved,stamp("2026-10-28",19));
 assert.equal(next.dueDate,"2026-10-29");
 assert.equal(next.side,"right");
});
test("running out of inventory sets the purchase reminder without clearing injection history",async()=>{
 const initial={...base("2026-10-01"),confirmedDueDates:["2026-10-15"],isDepleted:false,subscription:null};
 const {device,db}=fakeState(initial);
 const response=await device.fetch(new Request("https://internal/inventory",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({dosesRemaining:0,orderPending:false})}));
 assert.equal(response.status,200);
 const saved=db.get("state");
 assert.equal(saved.isDepleted,true);
 assert.ok(saved.purchaseReminderAt);
 assert.deepEqual(saved.confirmedDueDates,["2026-10-15"]);
});
test("an ordered package or newly available doses cancel the purchase alert",async()=>{
 const initial={...base("2026-10-01"),isDepleted:true,purchaseReminderAt:"2026-10-20T07:00:00.000Z",subscription:null};
 const {device,db}=fakeState(initial);
 const req=n=>new Request("https://internal/inventory",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({dosesRemaining:n,orderPending:false})});
 assert.equal((await device.fetch(req(2))).status,200);
 assert.equal(db.get("state").purchaseReminderAt,null);
 assert.equal((await device.fetch(req(0))).status,200);
 assert.ok(db.get("state").purchaseReminderAt);
 const ordered=new Request("https://internal/inventory",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({dosesRemaining:0,orderPending:true})});
 assert.equal((await device.fetch(ordered)).status,200);
 assert.equal(db.get("state").purchaseReminderAt,null);
});
test("invalid stock counts are rejected safely",async()=>{
 const initial={...base("2026-10-01"),isDepleted:false,subscription:null};
 const {device,db}=fakeState(initial);
 const response=await device.fetch(new Request("https://internal/inventory",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({dosesRemaining:-1,orderPending:false})}));
 assert.equal(response.status,400);
 assert.equal(db.get("state").isDepleted,false);
});
