import { loginAppearanceBootstrap, LOGIN_STYLES } from "./login-appearance.mjs";

const copy = {
  "zh-Hans": {
    title: "\u767b\u5f55 \u00b7 SciKeel",
    username: "\u7528\u6237\u540d", usernamePlaceholder: "\u8bf7\u8f93\u5165\u7528\u6237\u540d", password: "\u5bc6\u7801", passwordPlaceholder: "\u8bf7\u8f93\u5165\u5bc6\u7801",
    showPassword: "\u663e\u793a\u5bc6\u7801", hidePassword: "\u9690\u85cf\u5bc6\u7801", submit: "\u767b\u5f55", submitting: "\u6b63\u5728\u767b\u5f55\u2026",
    invalidCredentials: "\u7528\u6237\u540d\u6216\u5bc6\u7801\u4e0d\u6b63\u786e\uff0c\u8bf7\u68c0\u67e5\u540e\u91cd\u8bd5\u3002", capsLock: "\u5927\u5199\u9501\u5b9a\u5df2\u5f00\u542f",
    requiredUsername: "\u8bf7\u8f93\u5165\u7528\u6237\u540d\u3002", requiredPassword: "\u8bf7\u8f93\u5165\u5bc6\u7801\u3002",
  },
  en: {
    title: "Sign in \u00b7 SciKeel",
    username: "Username", usernamePlaceholder: "Enter your username", password: "Password", passwordPlaceholder: "Enter your password",
    showPassword: "Show password", hidePassword: "Hide password", submit: "Sign in", submitting: "Signing in\u2026",
    invalidCredentials: "Incorrect username or password. Please try again.", capsLock: "Caps Lock is on",
    requiredUsername: "Enter your username.", requiredPassword: "Enter your password.",
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
  const mark = '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M25 6H12L6 13H22L26 20L20 26H7M12 6L7 26M25 6L20 26" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return `<!doctype html>
<html lang="${locale}" data-theme="light">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFBUlEQVR4nO2XT2zcVxHHP/Pe++3artqmSA2JiO00RFVxJIgSEcC1WQkBTfnby7ZSpZ5AQSiyQ04cOKx/AiFFqKIqUJQrJ2AluHAoqAWWOmpRSVJVyIeqsto0NCFRnBQ79u7+3pvhsE5ie9f2hgMXmMtKqzfz/c7M+86bH/yvm9z9+drd+gC5AXb3fuvM/gPgddbTv8+gJiC2+/CxoXDffbslNhULffi2sOweaeryP682XlhaxVtXiT6C1Bzkumti6sGyD38yeBiNArjtfcUQZ5i+E2L26Pyrz17t4MttEtsFEapzMjZWLZWc+4347ACWMqQfcAAzxALY3lapXQIMZtYlHbYEr9Q89TwuTk79wofShKW2YpzD/FOWJZHC97xYkSIEsojTZ3zpnlpqLZ35R+P5i6ut1P4IHD4WaOTFnsnpH/jSwNNarKy4MDho2nz5wuxz8/3kPzw5/VFxXjA5A0BlxtMgbk+gUgs08mJk8vg3XVb+nsU2mJQwxcTOUK16FncF7r0cu3yvjAk7D9ju+ZfKwGc1thFhFoCdc10V6yZQrXrqeRx+9PgXxJVOm0bU0jkR+YTG9pJz7hXq9QSkrbL3lel9TsKoFiuLocjOAlCv68Zz6wnUao48TyMTU2Pi/a/EB6fFSgPci748dCi1l+dMZXB4/PiQ+GyT/reCywZUivhVNzBAai69Mf/qs1duSXkLAibk2Gjlxg4zexHxD2hsqokcAj6TihUMOyiib0vwQFcyqwEziAmEzDRhwmtAz/53VwAhtU46yWISFBAnIvdiBmY48SWg1BN5XRiHaaGWopmll4Ge/d9AQAyQi6/9eGHf57970DSNFpZUTMecC780TUuKfonorltQEee6Amqh3mUuSYpfFl86ZZqSF3eFLQbexktoAPMvnfoAeBNgdGL6k748JLG1eP69xvOz22YP7KlMHwkIiHOmaQb4er8Ebplw+HTg7LFocuIo4sBkllrNMUdgrLuXAPzukufs6Sh64it4wVIUCaWvDU9OffG9+k/+0FFYfZ16Nh9EZ79V7D/693LrJkc0rWo5z5VqNZF3y4lOmYv9R8vl9k05oqmtBu86cQ+J8CMqtT8y1rlYrHmQes/0WufNL1bcx5wPe7VYWfRF2FTLG33Ehz2oLojqMxpb13029PFhvfaNTgK/XofZm8CfV/9PNu6zIYDzd7S8yWKxxsdlgyAyf2H2p2fATgMq4r7/0KemP0z9ybR2t+hNYOcBAzBnk53nVDqXrzLje55f6yM2Kc5jxm/3fO7kR3D+CdPkwHwqOccGRfQiINSfTPuPTpXN+LSmtmw1y7t8hPHUXk4m/MsV8fc+DD5iGhdM9LELrzx3qdOqOxOx+xLWakKeW6f/bq+2l2+KS+c7i8kcnd8NVsHRQIvlhTHnwojGViHwQ5cN3K/FyrVkrccv/uXnf6Na9eT5Niro9FJJNu6Hhiiai3+90HjhMgD1TfJvdOay2dS4cxmkaM5n91uKt8Bfp1IL1PPtRjFreskEiInaWyMT39l3e8noYcmp9+qSiT5uGlWczzAWkjXvgDe6waF7RApgIxPffgAX3hYJHzKNkb72P0DEiQuAXU/afGw7cDYJLBoHBLhhmPb/6SAGEsHe7xccekcXwEYrJ3b4rPRgbC4lKPeBHy2UB0Pzg+WF91//2bVeY/e/aD2UsoltUV8TajNCfje4QD5jvTaf/9tm9m+9UGvyqViRhQAAAABJRU5ErkJggg==">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/brand/scikeel-touch-v4.png">
<meta name="color-scheme" content="light"><title>${text.title}</title>${preloads}
<style>${LOGIN_STYLES}</style>
</head>
<body><main class="shell"><section class="card" aria-label="${text.submit}" data-label="submit">
<div class="brand"><div class="mark">${mark}</div><span class="brand-name">SciKeel</span></div>
${invalidCredentials ? `<p class="error" id="login-error" role="alert" tabindex="-1">${label("invalidCredentials")}</p>` : ""}
<form method="post" action="/auth/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><input type="hidden" name="lang" value="${locale}">
<div class="field"><label for="username">${label("username")}</label><input id="username" name="username" value="${escapeHtml(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${text.usernamePlaceholder}" data-placeholder="usernamePlaceholder" required${invalidCredentials ? ' aria-invalid="true" aria-describedby="login-error"' : ""}></div>
<div class="field"><label for="password">${label("password")}</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="current-password" placeholder="${text.passwordPlaceholder}" data-placeholder="passwordPlaceholder" required${invalidCredentials ? ' aria-invalid="true" aria-describedby="login-error"' : ""}><button class="password-toggle" type="button" aria-label="${text.showPassword}" aria-controls="password" aria-pressed="false" hidden>${eye}</button></div><p class="caps-lock" role="status" hidden>${label("capsLock")}</p></div>
<button class="submit" type="submit">${label("submit")}<svg class="submit-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/></svg></button></form></section></main>
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
    toggle.setAttribute('aria-label', text[password.type === 'password' ? 'showPassword' : 'hidePassword']);
    username.setCustomValidity('');
    password.setCustomValidity('');
  }
  if (!${Boolean(explicitLocale || invalidCredentials)}) {
    try { const saved = localStorage.getItem('scikeel.login.locale'); if (saved === 'en' || saved === 'zh-Hans') applyLocale(saved); } catch {}
  }
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
    const css = LOGIN_STYLES;
    const body = page.match(/<body>([\s\S]*?)<script>/)[1];
    return [locale, `<style>${css}:host{display:block;min-height:100vh;background:var(--login-bg);color:var(--login-text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.return-to-login{display:block;width:100%;min-height:44px;margin-top:12px;border:0;border-radius:6px;background:transparent;color:var(--login-text);font-size:14px}.return-to-login:hover{background:var(--login-border)}.return-to-login-error{margin-top:12px}</style>${body}`];
  }));
  const payload = JSON.stringify(templates).replaceAll("<", "\\u003c");
  const head = `<script>${loginAppearanceBootstrap({ followSystem: false })}</script><style id="scikeel-login-visibility">html[data-scikeel-login-preparing] #root{visibility:hidden}</style><script>
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
  host.dataset.theme = 'light';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto';
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
  document.addEventListener('scikeel:login-waiting', event => {
    if (failed) return;
    submit.querySelector('[data-copy]').textContent = event.detail?.waiting
      ? (locale === 'en' ? 'Waiting for workspace…' : '正在等待工作区…')
      : (locale === 'en' ? 'Signing in…' : '正在登录…');
  });
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'return-to-login'; back.hidden = true;
  back.textContent = locale === 'en' ? 'Back to sign in' : '返回登录';
  form.after(back);
  const backError = document.createElement('p');
  backError.className = 'error return-to-login-error'; backError.hidden = true;
  backError.setAttribute('role', 'alert'); back.after(backError);
  back.addEventListener('click', () => {
    back.disabled = true; back.setAttribute('aria-busy', 'true');
    backError.hidden = true;
    submit.disabled = true;
    document.dispatchEvent(new Event('scikeel:return-to-login'));
  });
  document.addEventListener('scikeel:return-to-login-failed', () => {
    back.disabled = false; back.removeAttribute('aria-busy');
    submit.disabled = false;
    backError.textContent = locale === 'en' ? 'Could not return to sign in. Please retry.' : '暂时无法返回登录，请重试。';
    backError.hidden = false;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (failed) {
      try { sessionStorage.setItem('scikeel.login.pending', JSON.stringify({ locale, startedAt: Date.now() })); } catch {}
      location.reload();
    }
  });
  const handoff = () => {
    host.remove();
    if (root) root.inert = false;
    document.documentElement.removeAttribute('data-scikeel-login-preparing');
    try { sessionStorage.removeItem('scikeel.login.pending'); } catch {}
  };
  document.addEventListener('scikeel:login-ready', handoff, { once: true });
  document.addEventListener('scikeel:login-error', () => {
    failed = true;
    back.hidden = false;
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
