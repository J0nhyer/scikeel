import {createInterface} from "node:readline";
const input=createInterface({input:process.stdin});let started=false;
const send=value=>process.stdout.write(JSON.stringify(value)+"\n");
input.on("line",line=>{
  const value=JSON.parse(line);
  if(value.method==="initialize")send({id:value.id,result:{userAgent:"fixture"}});
  else if(value.method==="thread/start" || value.method==="thread/resume")send({id:value.id,result:{thread:{id:value.params.threadId??"native-owned"}}});
  else if(value.method==="turn/start") {
    if(process.argv[2]==="early-delta")send({method:"item/agentMessage/delta",params:{threadId:"native-owned",turnId:"turn-owned",itemId:"message-a",delta:"Accepted output"}});
    send({id:value.id,result:{turn:{id:"turn-owned"}}});started=true;
    if(process.argv[2]==="early-delta") {send({method:"turn/completed",params:{threadId:"native-owned",turn:{id:"turn-owned",status:"completed"}}});return;}
    if(process.argv[2]==="foreign-completion") {send({method:"turn/completed",params:{threadId:"native-owned",turn:{id:"another-turn",status:"completed"}}});return;}
    if(process.argv[2]==="missing-completion-thread") {send({method:"turn/completed",params:{turn:{id:"turn-owned",status:"completed"}}});return;}
    if(process.argv[2]==="missing-delta-turn") {send({method:"item/agentMessage/delta",params:{threadId:"native-owned",delta:"Unbound output"}});return;}
    if(process.argv[2]==="missing-approval-item") {send({id:901,method:"item/commandExecution/requestApproval",params:{threadId:"native-owned",turnId:"turn-owned",command:"unbound command"}});return;}
    if(process.argv[2]==="question")send({id:902,method:"item/tool/requestUserInput",params:{threadId:value.params.threadId,turnId:"turn-owned",isBlocking:true,itemId:"question-a",questions:[{id:"approach",header:"Approach",question:"Select approach",options:[{label:"Python",description:"Use scientific Python"}],isOther:true}]}});
    else send({id:901,method:"item/commandExecution/requestApproval",params:{threadId:value.params.threadId,turnId:"turn-owned",itemId:"command-a",startedAtMs:1,command:"python research.py"}});
  } else if(value.id===902 && value.result && started) {
    if(value.result.answers.approach.answers[0]!=="Python")throw new Error("invalid question answer");
    send({method:"turn/completed",params:{threadId:"native-owned",turn:{id:"turn-owned",status:"completed"}}});
  } else if(value.id===901 && value.result && started) {
    if(value.result.decision==="accept") {
      send({method:"item/agentMessage/delta",params:{threadId:"native-owned",turnId:"turn-owned",delta:"Actual fixture result"}});
      send({method:"turn/completed",params:{threadId:"native-owned",turn:{id:"turn-owned",status:"completed"}}});
    }else send({method:"turn/completed",params:{threadId:"native-owned",turn:{id:"turn-owned",status:"interrupted"}}});
  }
});
