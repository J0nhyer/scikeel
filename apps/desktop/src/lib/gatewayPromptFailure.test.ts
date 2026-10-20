import {describe,it,expect} from "vitest";
import {ApiError} from "@ai4s/sdk";
import {gatewayPromptFailureKey} from "./gatewayPromptFailure";
describe("safe gateway prompt failure presentation",()=>{
  it.each([
    [429,"workspace_rpc_busy","workspaceBusy"], [429,"workspace_rpc_queue_full","workspaceBusy"],
    [504,"workspace_rpc_timeout","workspaceTimeout"], [403,"workspace_rpc_denied","workspaceDenied"],
    [409,"research_execution_running","executionRunning"], [502,"prompt_delivery_unknown","deliveryUnconfirmed"],
    [409,"turn_uncertain","deliveryUnconfirmed"], [503,"prompt_recovery_failed","recoveryUnconfirmed"],
    [502,"model_upstream_rejected","providerRejected"],
  ])("maps %s/%s without reflecting raw helper data",(status,code,key)=>{
    expect(gatewayPromptFailureKey(new ApiError("synthetic-private-body",status,{code,source:"gateway"})))
      .toBe(`session:composer.error.${key}`);
  });
  it("keeps unrelated validation messages and treats fetch failures as unconfirmed",()=>{
    expect(gatewayPromptFailureKey(new Error("select a model"))).toBeNull();
    expect(gatewayPromptFailureKey(new TypeError("Failed to fetch"))).toBe("session:composer.error.deliveryUnconfirmed");
  });
});
