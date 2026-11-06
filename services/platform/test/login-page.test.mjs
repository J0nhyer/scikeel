import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withLoginPreparation } from "../src/login-page.mjs";

const { JSDOM } = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url))("jsdom");

function preparation(locale, { storage = {} } = {}) {
  return new JSDOM(withLoginPreparation("<html><head></head><body><div id=\"root\"></div></body></html>"), {
    url: "http://localhost/", runScripts: "dangerously",
    beforeParse(window) {
      for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
      window.sessionStorage.setItem("scikeel.login.pending", JSON.stringify({ locale, startedAt: Date.now() }));
    },
  });
}

for (const locale of ["en", "zh-Hans"]) {
  test(`login preparation uses one loading surface and no cloned form (${locale})`, () => {
    const dom = preparation(locale);
    try {
      const { document, Event } = dom.window;
      const host = document.getElementById("scikeel-login-preparation");
      const shadow = host.shadowRoot;
      assert.equal(shadow.querySelector("form"), null);
      assert.equal(shadow.querySelector("#username"), null);
      assert.equal(shadow.querySelector(".submit-spinner"), null);
      assert(shadow.querySelector('[data-scikeel-boot-gate="1"]'));
      assert.equal(shadow.querySelectorAll('[role="status"]').length, 1);
      assert.equal(shadow.textContent.includes(locale === "en" ? "workspace" : "工作区"), false);
      document.dispatchEvent(new Event("scikeel:login-ready"));
      assert.equal(document.getElementById("scikeel-login-preparation"), null);
      assert.equal(document.documentElement.hasAttribute("data-scikeel-login-preparing"), false);
    } finally { dom.window.close(); }
  });

  test(`login failure shows one neutral sentence and one retry action (${locale})`, () => {
    const dom = preparation(locale);
    try {
      const { document, Event } = dom.window;
      const shadow = document.getElementById("scikeel-login-preparation").shadowRoot;
      document.dispatchEvent(new Event("scikeel:login-error"));
      const error = shadow.querySelector(".scikeel-loading-error");
      assert(error);
      assert(shadow.querySelector(".scikeel-loading > .scikeel-loading-error"));
      assert.equal(error.querySelectorAll("p").length, 1);
      assert.match(error.textContent, locale === "en" ? /Service resources are busy/ : /服务资源紧张/);
      assert.equal(error.textContent.includes(locale === "en" ? "workspace" : "工作区"), false);
      assert.equal(error.querySelectorAll("button").length, 1);
      assert.equal(error.querySelector("button").textContent, locale === "en" ? "Retry" : "重试");
    } finally { dom.window.close(); }
  });
}

test("login preparation surface follows the stored dark theme", () => {
  const dom = preparation("en", { storage: { "ai4s.theme.v2": "dark" } });
  try {
    const host = dom.window.document.getElementById("scikeel-login-preparation");
    assert.equal(host.dataset.theme, "dark");
    const styles = host.shadowRoot.querySelector("style").textContent;
    assert.match(styles, /:host\(\[data-theme="dark"\]\)/);
    assert.match(styles, /100svh/);
    assert.match(styles, /safe-area-inset/);
  } finally { dom.window.close(); }
});

test("a normal reload without a pending login is not gated", () => {
  const dom = new JSDOM(withLoginPreparation("<html><head></head><body><div id=\"root\"></div></body></html>"), {
    url: "http://localhost/", runScripts: "dangerously",
  });
  try {
    assert.equal(dom.window.document.getElementById("scikeel-login-preparation"), null);
    assert.equal(dom.window.document.documentElement.hasAttribute("data-scikeel-login-preparing"), false);
  } finally { dom.window.close(); }
});

test("a structured workspace recovery hands off the login overlay", () => {
  const dom = preparation("en");
  try {
    const { document, Event } = dom.window;
    assert(document.getElementById("scikeel-login-preparation"));
    document.dispatchEvent(new Event("scikeel:login-recovery"));
    assert.equal(document.getElementById("scikeel-login-preparation"), null);
    assert.equal(document.documentElement.hasAttribute("data-scikeel-login-preparing"), false);
    assert.equal(document.getElementById("root").inert, false);
  } finally { dom.window.close(); }
});
