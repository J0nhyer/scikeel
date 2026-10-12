import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { loginPage } from "../src/login-page.mjs";
import { loginAppearanceBootstrap } from "../src/login-appearance.mjs";

test("workbench bootstrap resolves the same choices and legacy preference without requiring storage", () => {
  for (const [saved, legacy, dark, expected] of [["cdut",null,true,"cdut"],["system",null,true,"dark"],["system",null,false,"light"],[null,"light",true,"warm"],["bad",null,true,"dark"]]) {
    const document = { documentElement: { dataset: {} } };
    runInNewContext(loginAppearanceBootstrap(), { document, localStorage: { getItem: key => key === "ai4s.theme.v2" ? saved : legacy }, matchMedia: () => ({ matches: dark }) });
    assert.equal(document.documentElement.dataset.theme, expected);
  }
  const document = { documentElement: { dataset: {} } };
  runInNewContext(loginAppearanceBootstrap(), { document, localStorage: { getItem() { throw Error("blocked"); } } });
  assert.equal(document.documentElement.dataset.theme, "light");
});
test("system workbench bootstrap changes with the OS while CDUT stays fixed", () => {
  let update;
  const media = { matches: false, addEventListener: (_event, fn) => { update = fn; } };
  const document = { documentElement: { dataset: {} } };
  runInNewContext(loginAppearanceBootstrap(), { document, localStorage: { getItem: () => "system" }, matchMedia: () => media });
  media.matches = true; update();
  assert.equal(document.documentElement.dataset.theme, "dark");
});
test("the authenticated app bootstrap does not leave a competing system listener", () => {
  let listeners = 0;
  const document = { documentElement: { dataset: {} } };
  runInNewContext(loginAppearanceBootstrap({ followSystem: false }), {
    document, localStorage: { getItem: () => "system" },
    matchMedia: () => ({ matches: false, addEventListener: () => { listeners++; } }),
  });
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(listeners, 0);
});

test("login and workbench embed the preferred original favicon without a network fetch", async () => {
  const icon = await readFile(new URL("../../../apps/desktop/public/assets/brand/scikeel-icon-v4.png", import.meta.url));
  const workbench = await readFile(new URL("../../../apps/desktop/index.html", import.meta.url), "utf8");
  for (const html of [loginPage(), workbench]) {
    const links = html.match(/<link\b[^>]*rel="icon"[^>]*>/g);
    assert.equal(links.length, 1);
    const preferred = links.at(-1).match(/href="([^"]+)"/)[1];
    assert.ok(preferred.startsWith("data:image/png;base64,"));
    assert.deepEqual(Buffer.from(preferred.slice("data:image/png;base64,".length), "base64"), icon);
  }
});

test("public login stays fixed and does not read workbench appearance preferences", () => {
  const html = loginPage();
  assert.match(html, /data-theme="light"/);
  assert.match(html, /<form method="post" action="\/auth\/login">/);
  assert.doesNotMatch(html, /ai4s\.theme|prefers-color-scheme|data-campus-login|class="story"|<footer/);
  assert.match(loginPage({ username: '<script>bad</script>', invalidCredentials: true }), /&lt;script&gt;bad&lt;\/script&gt;/);
});
