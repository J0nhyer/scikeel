import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withLoginPreparation } from "../src/login-page.mjs";

const { JSDOM } = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url))("jsdom");

function preparation(locale) {
  return new JSDOM(withLoginPreparation("<html><head></head><body><div id=\"root\"></div></body></html>"), {
    url: "http://localhost/", runScripts: "dangerously",
    beforeParse(window) {
      window.sessionStorage.setItem("scikeel.login.pending", JSON.stringify({ locale, startedAt: Date.now() }));
    },
  });
}

for (const locale of ["en", "zh-Hans"]) {
  test(`login preparation exposes recovery actions only after failure (${locale})`, () => {
    const dom = preparation(locale);
    try {
      const { document, Event } = dom.window;
      const shadow = document.getElementById("scikeel-login-preparation").shadowRoot;
      const back = shadow.querySelector(".return-to-login");
      assert(back, "Preparation has a return-to-login action");
      assert.equal(back.hidden, true);
      assert.equal(shadow.textContent.includes(locale === "en" ? "Sign out" : "退出登录"), false);
      assert.equal(shadow.querySelector(".submit").disabled, true);
      document.dispatchEvent(new Event("scikeel:login-error"));
      document.dispatchEvent(new Event("scikeel:login-error"));
      assert.equal(back.hidden, false);
      assert.equal(back.textContent, locale === "en" ? "Back to sign in" : "返回登录");
      assert.equal(shadow.querySelector(".submit").textContent, locale === "en" ? "Retry" : "重试");
      assert.equal(shadow.querySelectorAll("p.error:not([hidden])").length, 1);
      let returns = 0;
      document.addEventListener("scikeel:return-to-login", () => { returns++; });
      back.click(); back.click();
      assert.equal(returns, 1);
      document.dispatchEvent(new Event("scikeel:return-to-login-failed"));
      assert.equal(back.disabled, false);
      assert.equal(shadow.querySelector(".return-to-login-error").hidden, false);
      back.click();
      assert.equal(returns, 2);
    } finally { dom.window.close(); }
  });
}
