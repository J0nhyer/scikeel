import test from "node:test";
import assert from "node:assert/strict";
import { PackageGrants } from "../src/package-grants.mjs";
import { packageRoute } from "../src/package-broker.mjs";

const context={userId:"a",instanceId:"user-a",generation:1};
const index=packageRoute("GET","/root/pypi/+simple/numpy/");
const archive=packageRoute("GET","/root/pypi/+f/abc/def1234567890a/numpy-1.0-py3-none-any.whl");
test("package capabilities bind account, generation, expiry and explicit public package names",()=>{
  let now=1000;const grants=new PackageGrants({now:()=>now});
  const token=grants.issue({...context,packages:["numpy"],expiresAt:2000});
  assert.equal(grants.authorize(context,index,token),true);assert.equal(grants.authorize(context,archive,token),true);
  assert.equal(grants.authorize({...context,userId:"b"},index,token),false);
  assert.equal(grants.authorize({...context,generation:2},index,token),false);
  assert.equal(grants.authorize(context,packageRoute("GET","/root/pypi/+simple/scipy/"),token),false);
  now=2000;assert.equal(grants.authorize(context,index,token),false);
});
test("revocation and bounded request accounting cannot be bypassed with a different archive name",()=>{
  const grants=new PackageGrants({now:()=>1000,maxRequests:2});
  const token=grants.issue({...context,packages:["numpy"],expiresAt:2000});
  assert.equal(grants.authorize(context,index,token),true);assert.equal(grants.authorize(context,archive,token),true);
  assert.equal(grants.authorize(context,index,token),false);
  const renewed=grants.issue({...context,packages:["numpy"],expiresAt:2000});grants.revokeContext(context);
  assert.equal(grants.authorize(context,index,renewed),false);
  assert.throws(()=>grants.issue({...context,packages:["https://private"],expiresAt:2000}));
});
