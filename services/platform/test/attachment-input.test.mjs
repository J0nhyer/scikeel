import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeUserInput, codexImageArgs } from "../src/attachment-input.mjs";
test("Claude receives image bytes and Codex receives actual image paths",()=>{
  assert.deepEqual(codexImageArgs(["/private/a.png","/private/b.png"]),["--image","/private/a.png","--image","/private/b.png"]);
  const value=JSON.parse(claudeUserInput("Describe",[{mime:"image/png",data:"aGVsbG8="}]));
  assert.equal(value.message.content[0].text,"Describe");
  assert.equal(value.message.content[1].source.data,"aGVsbG8=");
  assert.equal(value.message.content[1].source.media_type,"image/png");
});
