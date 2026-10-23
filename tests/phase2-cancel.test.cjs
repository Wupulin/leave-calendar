const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('app.js','utf8');
const relevant=source.slice(source.indexOf('function relevant('),source.indexOf('function groupCount('));
const toggle=source.slice(source.indexOf('function toggle('),source.indexOf('\n',source.indexOf('function toggle(')));
const mine={id:'mine',group:'ICU'};
const ctx=vm.createContext({state:{phase:2,bookings:{date:[{memberId:'mine',phase:1},{memberId:'other',phase:1},{memberId:'other',phase:2},{memberId:'mine',phase:3}]}},selected:'date',me:()=>mine,items:k=>ctx.state.bookings[k]||[],save:()=>{},toast:()=>{},closeDay:()=>{}});
vm.runInContext(relevant+toggle,ctx);
ctx.toggle();
assert.equal(ctx.state.bookings.date.length,3);
assert(!ctx.state.bookings.date.some(b=>b.memberId==='mine'&&b.phase===1));
assert(ctx.state.bookings.date.some(b=>b.memberId==='mine'&&b.phase===3));
assert.equal(ctx.state.bookings.date.filter(b=>b.memberId==='other').length,2);
for(const [phase,expected] of [[1,[true,false,false]],[2,[true,true,false]],[3,[false,false,true]]]){
 ctx.state.phase=phase;assert.deepEqual([1,2,3].map(p=>ctx.relevant({phase:p})),expected);
}
(async()=>{
 ctx.state.phase=2;ctx.state.bookings.date=[{id:'first-phase-id',memberId:'mine',phase:1}];
 const button={};const calls=[];
 Object.assign(ctx,{$:()=>button,cloudCall:async(action,payload)=>calls.push({action,payload}),cloudRefresh:async()=>{},cloudMessage:x=>x});button.close=()=>{};
 const start=source.indexOf("  $('#reserveBtn').onclick=async");
 vm.runInContext(source.slice(start,source.indexOf('\n',start)),ctx);
 await button.onclick();
 assert.equal(calls.length,1);assert.equal(calls[0].action,'cancel');assert.equal(calls[0].payload.bookingId,'first-phase-id');
 console.log('Passed: phase visibility, local cancellation preserves other members/long leave, cloud cancellation uses phase-one booking ID.');
})().catch(e=>{console.error(e);process.exitCode=1});
