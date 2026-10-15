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
const base = anchorDate => ({anchorDate,timeZone:zone,confirmedDueDates:[],purchaseReminderAt:null,subscription:{endpoint:"mock"}});

test("13 days after the last injection: reminder is at 20:00 the evening before",()=>{
 const {device}=fakeState();
 const event=device.nextEvent(base("2026-10-01"),stamp("2026-10-14",19));
 assert.equal(event.kind,"eve");
 assert.equal(event.dueDate,"2026-10-15");
 assert.equal(event.at,stamp("2026-10-14",20));
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
