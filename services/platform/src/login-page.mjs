const copy = {
  "zh-Hans": {
    title: "\u767b\u5f55 \u00b7 SciKeel", workspace: "AI \u79d1\u7814\u5de5\u4f5c\u53f0", hero: "\u8ba9\u7814\u7a76\uff0c", heroAccent: "\u66f4\u8fdb\u4e00\u6b65\u3002",
    intro: "\u4ece\u4e00\u4e2a\u60f3\u6cd5\u51fa\u53d1\uff0c\u8ba9 AI \u966a\u4f60\u68b3\u7406\u6587\u732e\u3001\u5206\u6790\u6570\u636e\u3001\u64b0\u5199\u62a5\u544a\u3002\u628a\u6bcf\u4e00\u6b65\u7814\u7a76\uff0c\u7559\u5728\u540c\u4e00\u4e2a\u5de5\u4f5c\u53f0\u3002",
    literature: "\u6587\u732e\u68b3\u7406", analysis: "\u6570\u636e\u5206\u6790", writing: "\u7814\u7a76\u5199\u4f5c", tagline: "\u8ba9\u60f3\u6cd5\u6709\u65b9\u5411\uff0c\u8ba9\u7814\u7a76\u6709\u8ff9\u53ef\u5faa\u3002",
    welcome: "\u6b22\u8fce\u56de\u6765", heading: "\u767b\u5f55\u7814\u7a76\u5de5\u4f5c\u53f0", description: "\u7ee7\u7eed\u4f60\u7684\u63a2\u7d22\uff0c\u8fde\u63a5\u60f3\u6cd5\u4e0e\u53d1\u73b0\u3002",
    username: "\u7528\u6237\u540d", usernamePlaceholder: "\u8bf7\u8f93\u5165\u7528\u6237\u540d", password: "\u5bc6\u7801", passwordPlaceholder: "\u8bf7\u8f93\u5165\u5bc6\u7801",
    showPassword: "\u663e\u793a\u5bc6\u7801", hidePassword: "\u9690\u85cf\u5bc6\u7801", submit: "\u767b\u5f55", submitting: "\u6b63\u5728\u767b\u5f55\u2026",
    invalidCredentials: "\u7528\u6237\u540d\u6216\u5bc6\u7801\u4e0d\u6b63\u786e\uff0c\u8bf7\u68c0\u67e5\u540e\u91cd\u8bd5\u3002", capsLock: "\u5927\u5199\u9501\u5b9a\u5df2\u5f00\u542f", accountHelp: "\u9700\u8981\u8d26\u53f7\u6216\u5fd8\u8bb0\u5bc6\u7801\uff1f\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458\u3002",
    language: "\u9009\u62e9\u8bed\u8a00", footer: "SciKeel \u00b7 \u4e3a\u6bcf\u4e00\u6b65\u7814\u7a76\u63d0\u4f9b\u652f\u6301", requiredUsername: "\u8bf7\u8f93\u5165\u7528\u6237\u540d\u3002", requiredPassword: "\u8bf7\u8f93\u5165\u5bc6\u7801\u3002",
  },
  en: {
    title: "Sign in \u00b7 SciKeel", workspace: "AI research workbench", hero: "Move your research", heroAccent: "forward.",
    intro: "Start with an idea. Explore literature, analyze data, and write with AI, keeping every step of your research in one workbench.",
    literature: "Literature review", analysis: "Data analysis", writing: "Research writing", tagline: "Give ideas direction. Keep research traceable.",
    welcome: "Welcome back", heading: "Sign in to your workbench", description: "Continue exploring. Connect ideas with discoveries.",
    username: "Username", usernamePlaceholder: "Enter your username", password: "Password", passwordPlaceholder: "Enter your password",
    showPassword: "Show password", hidePassword: "Hide password", submit: "Sign in", submitting: "Signing in\u2026",
    invalidCredentials: "Incorrect username or password. Please try again.", capsLock: "Caps Lock is on", accountHelp: "Need an account or forgot your password? Contact your administrator.",
    language: "Choose language", footer: "SciKeel \u00b7 Supporting every step of research", requiredUsername: "Enter your username.", requiredPassword: "Enter your password.",
  },
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function loginPage({ locale = "zh-Hans", next = "/", username = "", invalidCredentials = false, explicitLocale = false, preloads = "" } = {}) {
  locale = locale === "en" ? "en" : "zh-Hans";
  const text = copy[locale];
  const label = (key) => `<span data-copy="${key}">${text[key]}</span>`;
  const eye = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const mark = '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M7 22 16 5l9 17H7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 12v15M5 27h22M11 18h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${text.title}</title>${preloads}
<style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#283b38;background:#f7f8f5;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button,a,input{-webkit-tap-highlight-color:transparent}button,a{touch-action:manipulation}button{cursor:pointer}button:disabled{cursor:wait}a{color:inherit}svg{display:block;width:24px;height:24px}button:focus-visible,a:focus-visible{outline:3px solid #63a59b;outline-offset:4px}
.shell{min-height:100vh;min-height:100svh;max-width:1440px;margin:auto;padding:36px 64px;display:flex;flex-direction:column}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px}.mark{width:42px;height:42px;border-radius:12px;background:#21594f;color:white;display:grid;place-items:center}.mark svg{width:30px;height:30px}.brand-name{font-size:23px;font-weight:650;letter-spacing:-.7px}.brand-note{font-size:12px;color:#697872;margin-top:3px}.languages{display:flex;align-items:center;gap:4px;padding:4px;background:#edf0ea;border:1px solid #e2e7de;border-radius:10px}.languages a{text-decoration:none;display:block;padding:9px 12px;font-size:13px;border-radius:7px}.languages a[aria-current="true"]{background:white;box-shadow:0 1px 4px #233d3410;color:#21594f;font-weight:600}
main{flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,420px);align-items:center;gap:clamp(48px,8vw,128px);padding:60px 0 68px}.story{max-width:560px}.eyebrow{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:600;letter-spacing:2px;color:#547769}.eyebrow::before{content:"";width:20px;height:1px;background:#749187}.story h1{font-size:clamp(40px,4.3vw,60px);line-height:1.23;letter-spacing:-2px;font-weight:600;margin:24px 0}.story h1 span{display:block}.accent{color:#397463}.intro{max-width:440px;font-size:16px;line-height:1.95;color:#697872;margin:0}.features{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}.features span{padding:9px 13px;font-size:12px;color:#547066;border:1px solid #dce4d9;border-radius:8px;background:#ffffff70}
.research-art{position:relative;width:100%;height:180px;margin-top:38px;overflow:hidden;border-bottom:1px solid #dce4d9}.orbit{position:absolute;border:1px solid #d5e0d3;border-radius:50%;width:320px;height:320px;left:35px;top:20px}.orbit.two{width:240px;height:240px;left:75px;top:60px}.orbit.three{width:160px;height:160px;left:115px;top:100px}.art-axis{position:absolute;width:1px;height:160px;background:#dde5d9;left:195px;top:20px}.art-dot{position:absolute;width:12px;height:12px;border-radius:50%;background:#4d806c;left:189px;top:94px;box-shadow:0 0 0 8px #e3ebe0}.art-dot.small{width:7px;height:7px;left:323px;top:109px;background:#b69867;box-shadow:0 0 0 6px #eee9dd}.art-caption{position:absolute;bottom:15px;left:0;color:#789084;font-size:11px;letter-spacing:1px}
.card{background:#fff;border:1px solid #e1e6de;border-radius:20px;padding:40px;box-shadow:0 16px 56px #263b3010}.welcome{font-size:12px;letter-spacing:1px;color:#628276;margin:0 0 12px}.card h2{font-size:25px;line-height:1.35;letter-spacing:-.6px;margin:0 0 10px;font-weight:600}.description{font-size:13px;color:#79847d;line-height:1.7;margin:0 0 30px}.field{margin-bottom:20px}label{display:block;font-size:13px;font-weight:550;margin-bottom:9px}input:not([type=hidden]){width:100%;height:48px;border:1px solid #dce3d9;border-radius:9px;background:#fcfdfb;padding:0 14px;font-size:14px;color:#283b38;transition:border-color .15s,box-shadow .15s}input::placeholder{color:#98a198}input:focus{outline:none;border-color:#568476;box-shadow:0 0 0 3px #56847615}input[aria-invalid="true"]{border-color:#bd7863}.password-wrap{position:relative}.password-wrap input{padding-right:52px}.password-toggle{position:absolute;right:4px;top:2px;width:44px;height:44px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:#819087}.password-toggle:hover{color:#21594f;background:#eef3ec}.password-toggle svg{width:19px;height:19px}.submit{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:48px;margin-top:8px;border:0;border-radius:9px;background:#21594f;color:#fff;font-size:14px;font-weight:600;transition:background .15s}.submit:hover{background:#17463e}.submit:disabled{opacity:.75}.submit svg{width:17px;height:17px}.submit-spinner{display:none;animation:login-spin .8s linear infinite}.submit[aria-busy="true"] .submit-spinner{display:block}.submit[aria-busy="true"] .submit-arrow{display:none}@keyframes login-spin{to{transform:rotate(360deg)}}.account-help{font-size:12px;line-height:1.8;color:#829086;text-align:center;margin:23px 0 0}.error{padding:12px 14px;margin:0 0 22px;background:#fcf1ed;color:#a04e36;border:1px solid #efdad1;border-radius:9px;font-size:13px;line-height:1.6}.caps-lock{font-size:12px;color:#996231;margin:8px 0 0}[hidden]{display:none!important}footer{display:flex;justify-content:space-between;gap:16px;font-size:11px;line-height:1.7;color:#879387}
@media(min-width:1440px){.shell{padding-left:100px;padding-right:100px}}@media(max-width:900px){.shell{padding:28px 32px}main{gap:36px}.card{padding:30px}.story h1{font-size:40px}.intro{font-size:14px}.research-art{height:140px}.features{gap:6px}.features span{padding:8px;font-size:11px}}
@media(max-width:700px){.shell{padding:22px 20px;max-width:500px}.brand-note{display:none}.brand-name{font-size:21px}.mark{width:36px;height:36px}.languages a{padding:8px 10px}main{display:flex;flex-direction:column;align-items:stretch;gap:26px;padding:42px 0 32px}.story h1{font-size:34px;letter-spacing:-1px;margin:14px 0 12px}.story h1 span{display:inline}.intro{font-size:13px;line-height:1.8}.eyebrow,.features,.research-art{display:none}.card{padding:28px 24px;border-radius:16px}.card h2{font-size:23px}.description{margin-bottom:25px}footer{justify-content:center;text-align:center}.footer-tagline{display:none}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}.submit-spinner{animation:none}}
</style>
</head>
<body><div class="shell">
<header class="topbar"><div class="brand"><div class="mark">${mark}</div><div><div class="brand-name">SciKeel</div><div class="brand-note">${label("workspace")}</div></div></div>
<nav class="languages" aria-label="${text.language}" data-label="language"><a href="/login?lang=zh-Hans&amp;next=${escapeHtml(encodeURIComponent(next))}" data-locale="zh-Hans" lang="zh-Hans" aria-current="${locale === "zh-Hans"}">\u7b80\u4f53\u4e2d\u6587</a><a href="/login?lang=en&amp;next=${escapeHtml(encodeURIComponent(next))}" data-locale="en" lang="en" aria-current="${locale === "en"}">English</a></nav></header>
<main><section class="story" aria-labelledby="story-heading"><div class="eyebrow">SCIENCE, WITH DIRECTION</div><h1 id="story-heading">${label("hero")}<span class="accent" data-copy="heroAccent">${text.heroAccent}</span></h1><p class="intro">${label("intro")}</p><div class="features">${label("literature")}${label("analysis")}${label("writing")}</div><div class="research-art" aria-hidden="true"><div class="orbit"></div><div class="orbit two"></div><div class="orbit three"></div><div class="art-axis"></div><div class="art-dot"></div><div class="art-dot small"></div><div class="art-caption">EXPLORE / CONNECT / DISCOVER</div></div></section>
<section class="card" aria-labelledby="login-heading"><p class="welcome">${label("welcome")}</p><h2 id="login-heading">${label("heading")}</h2><p class="description">${label("description")}</p>
${invalidCredentials ? `<p class="error" id="login-error" role="alert" tabindex="-1">${label("invalidCredentials")}</p>` : ""}
<form method="post" action="/auth/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><input type="hidden" name="lang" value="${locale}">
<div class="field"><label for="username">${label("username")}</label><input id="username" name="username" value="${escapeHtml(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${text.usernamePlaceholder}" data-placeholder="usernamePlaceholder" required${invalidCredentials ? ' aria-invalid="true" aria-describedby="login-error"' : ""}></div>
<div class="field"><label for="password">${label("password")}</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="current-password" placeholder="${text.passwordPlaceholder}" data-placeholder="passwordPlaceholder" required${invalidCredentials ? ' aria-invalid="true" aria-describedby="login-error"' : ""}><button class="password-toggle" type="button" aria-label="${text.showPassword}" aria-controls="password" aria-pressed="false" hidden>${eye}</button></div><p class="caps-lock" role="status" hidden>${label("capsLock")}</p></div>
<button class="submit" type="submit">${label("submit")}<svg class="submit-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/></svg><svg class="submit-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></form><p class="account-help">${label("accountHelp")}</p></section></main>
<footer><span>${label("footer")}</span><span class="footer-tagline">${label("tagline")}</span></footer>
</div>
<script>
(() => {
  const translations = ${JSON.stringify(copy)};
  const form = document.querySelector('form');
  const password = document.getElementById('password');
  const username = document.getElementById('username');
  const toggle = document.querySelector('.password-toggle');
  const submit = document.querySelector('.submit');
  let locale = document.documentElement.lang;
  function rememberLocale() {
    try { localStorage.setItem('scikeel.login.locale', locale); localStorage.setItem('ai4s.locale', locale); } catch {}
  }
  function applyLocale(value) {
    locale = value === 'en' ? 'en' : 'zh-Hans';
    const text = translations[locale];
    document.documentElement.lang = locale;
    document.title = text.title;
    form.elements.lang.value = locale;
    document.querySelectorAll('[data-copy]').forEach(element => { element.textContent = element.dataset.copy === 'submit' && submit.disabled ? text.submitting : text[element.dataset.copy]; });
    document.querySelectorAll('[data-placeholder]').forEach(element => { element.placeholder = text[element.dataset.placeholder]; });
    document.querySelectorAll('[data-label]').forEach(element => { element.setAttribute('aria-label', text[element.dataset.label]); });
    document.querySelectorAll('[data-locale]').forEach(element => { element.setAttribute('aria-current', String(element.dataset.locale === locale)); });
    toggle.setAttribute('aria-label', text[password.type === 'password' ? 'showPassword' : 'hidePassword']);
    username.setCustomValidity('');
    password.setCustomValidity('');
  }
  if (!${Boolean(explicitLocale || invalidCredentials)}) {
    try { const saved = localStorage.getItem('scikeel.login.locale'); if (saved === 'en' || saved === 'zh-Hans') applyLocale(saved); } catch {}
  }
  document.querySelectorAll('[data-locale]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    applyLocale(link.dataset.locale);
    rememberLocale();
    const url = new URL(location.href);
    url.searchParams.set('lang', locale);
    history.replaceState(null, '', url);
  }));
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', translations[locale][show ? 'hidePassword' : 'showPassword']);
  });
  password.addEventListener('keydown', event => { document.querySelector('.caps-lock').hidden = !event.getModifierState('CapsLock'); });
  password.addEventListener('keyup', event => { document.querySelector('.caps-lock').hidden = !event.getModifierState('CapsLock'); });
  password.addEventListener('blur', () => { document.querySelector('.caps-lock').hidden = true; });
  [username, password].forEach(input => {
    input.addEventListener('invalid', () => { if (input.validity.valueMissing) input.setCustomValidity(translations[locale][input === username ? 'requiredUsername' : 'requiredPassword']); });
    input.addEventListener('input', () => { input.setCustomValidity(''); input.removeAttribute('aria-invalid'); });
  });
  function resetSubmission() { try { sessionStorage.removeItem('scikeel.login.pending'); } catch {} submit.disabled = false; submit.removeAttribute('aria-busy'); form.removeAttribute('aria-busy'); submit.querySelector('[data-copy]').textContent = translations[locale].submit; }
  form.addEventListener('submit', event => {
    if (submit.disabled) { event.preventDefault(); return; }
    rememberLocale();
    try { sessionStorage.setItem('scikeel.login.pending', JSON.stringify({ locale, startedAt: Date.now() })); } catch {}
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    form.setAttribute('aria-busy', 'true');
    submit.querySelector('[data-copy]').textContent = translations[locale].submitting;
  });
  window.addEventListener('pageshow', resetSubmission);
  if (${Boolean(invalidCredentials)}) document.getElementById('login-error').focus();
})();
</script></body></html>`;
}

/** Preload only public client files; never execute the authenticated app here. */
export function loginAssetPreloads(html) {
  const paths = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"<>]+\.(?:js|css))"/g)].map(match => match[1]));
  return [...paths].map(path => path.endsWith(".js")
    ? `<link rel="modulepreload" href="${escapeHtml(path)}" crossorigin>`
    : `<link rel="preload" as="style" href="${escapeHtml(path)}" crossorigin>`).join("");
}

/** Continue showing the same login design while the real app boots underneath.
 * A fresh login leaves a locale/timestamp marker, never credentials or tokens.
 * Shadow DOM keeps login styling separate from the application stylesheet. */
export function withLoginPreparation(html) {
  const templates = Object.fromEntries(Object.keys(copy).map(locale => {
    const page = loginPage({ locale });
    const css = page.match(/<style>([\s\S]*?)<\/style>/)[1].replace(":root{", ":host{");
    const body = page.match(/<body>([\s\S]*?)<script>/)[1];
    return [locale, `<style>${css}:host{display:block;min-height:100vh;background:#f7f8f5}.languages{pointer-events:none}</style>${body}`];
  }));
  const payload = JSON.stringify(templates).replaceAll("<", "\\u003c");
  const head = `<style id="scikeel-login-visibility">html[data-scikeel-login-preparing] #root{visibility:hidden}</style><script>
try {
  const pending = JSON.parse(sessionStorage.getItem('scikeel.login.pending') || 'null');
  if (pending && typeof pending.startedAt === 'number' && Date.now() - pending.startedAt < 600000 && Date.now() >= pending.startedAt) {
    document.documentElement.setAttribute('data-scikeel-login-preparing', pending.locale === 'en' ? 'en' : 'zh-Hans');
  } else sessionStorage.removeItem('scikeel.login.pending');
} catch {}
</script>`;
  const body = `<script>
(() => {
  const locale = document.documentElement.getAttribute('data-scikeel-login-preparing');
  if (!locale) return;
  const templates = ${payload};
  const host = document.createElement('div');
  host.id = 'scikeel-login-preparation';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#f7f8f5';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = templates[locale];
  document.body.append(host);
  const root = document.getElementById('root');
  if (root) root.inert = true;
  const form = shadow.querySelector('form');
  shadow.querySelectorAll('input, .password-toggle').forEach(input => { input.disabled = true; if (input.tagName === 'INPUT') input.value = ''; });
  const submit = shadow.querySelector('.submit');
  submit.disabled = true;
  submit.setAttribute('aria-busy', 'true');
  form.setAttribute('aria-busy', 'true');
  submit.querySelector('[data-copy]').textContent = locale === 'en' ? 'Signing in…' : '正在登录…';
  let failed = false;
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (failed) {
      try { sessionStorage.setItem('scikeel.login.pending', JSON.stringify({ locale, startedAt: Date.now() })); } catch {}
      location.reload();
    }
  });
  document.addEventListener('scikeel:login-ready', () => {
    host.remove();
    if (root) root.inert = false;
    document.documentElement.removeAttribute('data-scikeel-login-preparing');
    try { sessionStorage.removeItem('scikeel.login.pending'); } catch {}
  }, { once: true });
  document.addEventListener('scikeel:login-error', () => {
    failed = true;
    submit.disabled = false;
    submit.removeAttribute('aria-busy');
    form.removeAttribute('aria-busy');
    submit.querySelector('[data-copy]').textContent = locale === 'en' ? 'Retry' : '重试';
    const error = document.createElement('p');
    error.className = 'error'; error.setAttribute('role', 'alert');
    error.textContent = locale === 'en' ? 'Your workspace could not be prepared. Please retry.' : '工作区暂时无法准备完成，请重试。';
    form.before(error);
  }, { once: true });
})();
</script>`;
  return html.replace('</head>', head + '</head>').replace('</body>', body + '</body>');
}
