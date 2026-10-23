const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const summary=source.slice(source.indexOf('function backupSummary('),source.indexOf('async function downloadFullBackup'));
const ctx=vm.createContext({cloudEnabled:true,cloudConfig:{url:'project'},me:()=>({id:'admin'})});
vm.runInContext(summary,ctx);
const backup={format:'np-leave-backup',version:1,project:'project',data:{members:[{id:'admin',is_admin:true,is_active:true}],settings:{id:1},bookings:[]}};
assert.match(ctx.backupSummary(backup),/預約：0 筆/);
for(const bad of [{...backup,version:2},{...backup,project:'other'},{...backup,data:{...backup.data,members:[]}},{...backup,data:{...backup.data,bookings:null}}])assert.throws(()=>ctx.backupSummary(bad));
(async()=>{
 let handler,rpcCalls=0;
 const api=fs.readFileSync('supabase/functions/leave-api/index.ts','utf8').replace(/^import .*\n/,'');
 const context=vm.createContext({Deno:{env:{get:()=>''},serve:fn=>handler=fn},createClient:()=>({rpc:async()=>{rpcCalls++;return {data:{members:[],settings:{},bookings:[]}}}}),Response,console});
 vm.runInContext(api,context);
 vm.runInContext('session=async()=>({member:{id:"admin",is_admin:false}})',context);
 const request=body=>({method:'POST',headers:new Headers(),json:async()=>body});
 assert.equal((await handler(request({action:'export-backup'}))).status,403);
 assert.equal((await handler(request({action:'restore-backup',backup}))).status,403);
 assert.equal(rpcCalls,0);
 vm.runInContext('session=async()=>({member:{id:"admin",is_admin:true}})',context);
 assert.equal((await handler(request({action:'restore-backup',backup}))).status,400); // wrong project
 assert.equal(rpcCalls,0);
 assert.equal((await handler(request({action:'export-backup'}))).status,200);
 assert.equal(rpcCalls,1);
 console.log('Passed: backup validation, cross-project/admin guards, backend authorization and export.');
})().catch(e=>{console.error(e);process.exitCode=1});
