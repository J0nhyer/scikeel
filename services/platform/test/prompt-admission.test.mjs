import test from "node:test";
import assert from "node:assert/strict";
import {PromptAdmission} from "../src/prompt-admission.mjs";
function fixture(){const calls=[];const admission=new PromptAdmission({
  collaboration:{rejectAdmission:async(...args)=>calls.push(["root",...args])},
  researchTasks:{rejectAdmission:async(...args)=>calls.push(["research",...args])},
});admission.turn={finish:async value=>calls.push(["turn",value])};return {calls,admission};}
test("not forwarded rejection releases only its own tickets before return",async()=>{
  const {calls,admission}=fixture();const owner={generation:1};admission.started(owner,7);admission.prepared({execution:2});
  await admission.rejectBeforeDispatch();assert.deepEqual(calls,[["turn",false],["research",{execution:2}],["root",owner,7]]);
  await admission.rejectBeforeDispatch();assert.equal(calls.length,3);assert.equal(admission.disposition,"rejected");
});
for(const disposition of ["unknown","accepted"])test(`${disposition} delivery never rejects potentially accepted work`,async()=>{
  const {calls,admission}=fixture();admission.started({generation:1},1);admission.dispatch();if(disposition==="accepted")admission.accepted();
  await admission.rejectBeforeDispatch();assert.deepEqual(calls,[]);assert.equal(admission.disposition,disposition);
});
test("inherited parent admission has no root cleanup ticket",async()=>{
  const {calls,admission}=fixture();await admission.rejectBeforeDispatch();assert.deepEqual(calls,[["turn",false]]);
});
test("receipt failure still attempts both store cleanups without claiming recovery",async()=>{
  const {calls,admission}=fixture();admission.turn.finish=async()=>{throw new Error("synthetic-private-body");};
  admission.started({generation:1},1);admission.prepared({execution:1});
  await assert.rejects(admission.rejectBeforeDispatch(),e=>e.code==="prompt_recovery_failed" && !e.message.includes("private"));
  assert.equal(calls.length,2);assert.equal(admission.disposition,"not_dispatched");
});
