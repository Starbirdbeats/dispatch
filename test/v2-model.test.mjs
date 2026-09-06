import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicket, initialData, transition, validateTicket } from '../public/v2/model.mjs';
const ticket=options=>createTicket({title:'Test workflow',goal:'Deliver a verified result',template:'blank',...options});
test('human gate cannot complete without an explicit approval',()=>{
 let t=transition(ticket(),'start');
 for(let i=0;i<4;i++)t=transition(t,'tick');
 assert.equal(t.state,'waiting');assert.equal(t.columnId,'attention');
 assert.equal(transition(t,'tick').state,'waiting');
 t=transition(t,'approve');assert.equal(t.state,'completed');assert.ok(t.stages.every(s=>s.status==='passed'));
 assert.ok(t.stages.every(s=>s.evidence.length));
});
test('failure routes back and invalidates downstream passes, retaining evidence',()=>{
 let t=transition(ticket({human:false}),'start');
 for(let i=0;i<3;i++)t=transition(t,'tick');
 assert.equal(t.stages[0].status,'passed');
 t=transition(t,'fail');assert.ok(t.stages.every(s=>s.status==='pending'));
 assert.equal(t.stages[0].attempts,1);assert.equal(t.stages[1].attempts,1);
 assert.equal(t.stages[1].evidence[0].result,'failed');
});
test('attempt cap stops a repeatedly failed gate',()=>{
 let t=ticket({limit:1});t=transition(transition(t,'start'),'tick');t=transition(t,'fail');
 assert.equal(t.state,'blocked');assert.equal(t.columnId,'attention');
 assert.equal(transition(t,'tick').state,'blocked');
});
test('upstream cap cannot be bypassed by a downstream bounce',()=>{
 let t=ticket({human:false,limit:1});t.stages[1].maxAttempts=3;
 t=transition(t,'start');for(let i=0;i<3;i++)t=transition(t,'tick');
 t=transition(t,'fail');t=transition(t,'tick');assert.equal(t.state,'blocked');
});
test('paused runs do not advance and active runs cannot edit or restart',()=>{
 let t=transition(ticket(),'start');assert.throws(()=>transition(t,'edit'));assert.throws(()=>transition(t,'start'));
 t=transition(t,'pause');assert.deepEqual(transition(t,'tick'),t);t=transition(t,'resume');assert.equal(t.state,'running');
});
test('template copies and transitions do not mutate other tickets or input',()=>{
 const a=ticket(),b=ticket();const snapshot=structuredClone(a);transition(a,'start');assert.deepEqual(a,snapshot);
 a.stages[0].prompt='Changed';assert.notEqual(b.stages[0].prompt,a.stages[0].prompt);assert.notEqual(a.stages[0].id,b.stages[0].id);
});
test('invalid gates and forward failure routes prevent starting',()=>{
 let t=ticket();t.stages[0].gate='';assert.ok(validateTicket(t).length);assert.throws(()=>transition(t,'start'));
 t=ticket();t.stages[0].failTarget=t.stages[1].id;assert.ok(validateTicket(t).length);
});
test('new state preserves separate board and graph concepts',()=>{
 const d=initialData();assert.equal(d.columns.length,4);assert.equal(d.tickets[0].columnId,'backlog');assert.ok(d.tickets[0].stages.length>1);
});
