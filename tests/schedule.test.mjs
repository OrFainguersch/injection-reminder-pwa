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
