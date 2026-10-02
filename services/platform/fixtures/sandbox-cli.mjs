import {createInterface} from "node:readline";
const input=createInterface({input:process.stdin});let started=false;
const send=value=>process.stdout.write(JSON.stringify(value)+"\n");
input.on("line",line=>{
  const value=JSON.parse(line);
  if(value.method==="initialize")send({id:value.id,result:{userAgent:"fixture"}});
  else if(value.method==="thread/start" || value.method==="thread/resume")send({id:value.id,result:{thread:{id:value.params.threadId??"native-owned"}}});
  else if(value.method==="turn/start") {
    send({id:value.id,result:{turn:{id:"turn-owned"}}});started=true;
    send({id:901,method:"item/commandExecution/requestApproval",params:{threadId:value.params.threadId,turnId:"turn-owned",itemId:"command-a",startedAtMs:1,command:"python research.py"}});
  } else if(value.id===901 && value.result && started) {
    if(value.result.decision==="accept") {
      send({method:"item/agentMessage/delta",params:{threadId:"native-owned",turnId:"turn-owned",delta:"Actual fixture result"}});
      send({method:"turn/completed",params:{threadId:"native-owned",turn:{id:"turn-owned",status:"completed"}}});
    }else send({method:"turn/completed",params:{threadId:"native-owned",turn:{id:"turn-owned",status:"interrupted"}}});
  }
});
