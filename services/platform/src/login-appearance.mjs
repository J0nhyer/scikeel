/** Workbench bootstrap before React mounts; public login keeps its own fixed palette. */
function applyLoginAppearance(followSystem) {
  let choice = "system";
  try {
    const saved = localStorage.getItem("ai4s.theme.v2");
    if (["light", "dark", "system", "cdut", "warm"].includes(saved)) choice = saved;
    else {
      const legacy = localStorage.getItem("ai4s.theme");
      if (legacy === "light") choice = "warm";
      else if (legacy === "dark") choice = "dark";
    }
  } catch { /* Storage is optional; the form remains usable. */ }
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const update = () => {
    document.documentElement.dataset.theme = choice === "system" ? (media?.matches ? "dark" : "light") : choice;
  };
  update();
  if (followSystem && choice === "system") media?.addEventListener?.("change", update);
}
export function loginAppearanceBootstrap({ followSystem = true } = {}) {
  return `(${applyLoginAppearance.toString()})(${Boolean(followSystem)});`;
}

/** Fixed, minimal public login styling, shared with the preparation ShadowRoot. */
export const LOGIN_STYLES = String.raw`
@font-face{font-family:Inter;font-style:normal;font-weight:400;font-display:swap;src:url('/assets/brand/inter-latin-400.woff2') format('woff2')}
@font-face{font-family:Inter;font-style:normal;font-weight:600;font-display:swap;src:url('/assets/brand/inter-latin-600.woff2') format('woff2')}
:root,:host{--login-bg:#fff;--login-text:#192b43;--login-muted:#65778d;--login-border:#dce5f0;--login-accent:#1e3e6e;--login-error:#b13e48;--login-warn:#98501d;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--login-bg);color:var(--login-text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:wait}
button:focus-visible{outline:2px solid var(--login-accent);outline-offset:4px}input:focus{outline:2px solid var(--login-accent);outline-offset:2px}[hidden]{display:none!important}
.shell{min-height:100svh;display:grid;place-items:center;padding:32px 24px}
.card{width:100%;max-width:320px}
.brand{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:36px;color:var(--login-accent)}
.mark{width:36px;height:36px}.mark svg{display:block;width:100%;height:100%}
.brand-name{font-size:25px;font-weight:600;letter-spacing:-.7px}
.field{margin-bottom:18px}label{display:block;margin-bottom:8px;font-size:13px;font-weight:600}
input{width:100%;min-width:0;height:46px;padding:0 13px;border:1px solid var(--login-border);border-radius:8px;background:#fff;color:var(--login-text);font-size:14px}
input::placeholder{color:var(--login-muted)}input[aria-invalid="true"]{border-color:var(--login-error)}
.password-wrap{position:relative}.password-wrap input{padding-right:49px}
.password-toggle{position:absolute;right:7px;top:7px;display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--login-muted)}
.password-toggle:hover{background:#f3f6fb}.password-toggle svg{width:18px;height:18px}
.caps-lock{font-size:12px;color:var(--login-warn);margin:8px 0 0}
.submit{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;margin-top:24px;padding:0 15px;border:0;border-radius:8px;background:var(--login-accent);color:#fff;font-size:14px;font-weight:600}
.submit:hover{background:#254b80}.submit-spinner{display:none;width:17px;height:17px}
.submit[aria-busy="true"] .submit-spinner{display:block;animation:spin 1s linear infinite}
.error{margin:0 0 20px;padding:12px 14px;border:1px solid #bc555d55;border-radius:8px;background:#fff9f9;color:var(--login-error);font-size:13px;line-height:1.6}
@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.submit-spinner{animation:none!important}}
`;
