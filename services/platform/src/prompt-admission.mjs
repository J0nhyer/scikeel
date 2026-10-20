/** Request-local ownership only; accepted/ambiguous work is reconciled by history/status. */
export class PromptAdmission {
  constructor({collaboration,researchTasks}) {
    Object.assign(this,{collaboration,researchTasks});
    this.stage="validation";this.disposition="not_dispatched";
    this.root=null;this.research=null;this.turn=null;this.cleaned=false;
  }
  started(owner,execution){this.root={owner,execution};}
  prepared(ticket){this.research=ticket;}
  dispatch(){this.stage="dispatch";this.disposition="unknown";}
  accepted(){this.stage="acknowledged";this.disposition="accepted";}
  async rejectBeforeDispatch(){
    if(this.cleaned || this.disposition!=="not_dispatched")return;
    this.cleaned=true;
    const results=await Promise.allSettled([
      Promise.resolve().then(()=>this.turn?.finish(false)),
      Promise.resolve().then(()=>this.research && this.researchTasks.rejectAdmission(this.research)),
      Promise.resolve().then(()=>this.root && this.collaboration.rejectAdmission(this.root.owner,this.root.execution)),
    ]);
    if(results.some(result=>result.status==="rejected"))throw Object.assign(new Error("Send recovery is not confirmed. Reload the conversation."),
      {statusCode:503,code:"prompt_recovery_failed"});
    this.disposition="rejected";
  }
}
