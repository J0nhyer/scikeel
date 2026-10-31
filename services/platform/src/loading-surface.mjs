/** The single loading surface shared by the server login handoff and the
 *  client boot root. It contains no status sentence: only the product mark and
 *  one ring. Failure copy is supplied by the caller after the 90s deadline. */
export const LOADING_SURFACE_STYLES = `
:host{display:block;color-scheme:light}
.scikeel-loading{position:fixed;inset:0;min-height:100svh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;padding:max(18px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(18px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left));background:#fff;color:#192b43}
.scikeel-loading-mark{width:44px;height:44px;color:#1e3e6e}
.scikeel-loading-spinner{width:32px;height:32px;color:#65778d;animation:scikeel-spin 1s linear infinite}
.scikeel-loading-error{display:flex;max-width:320px;flex-direction:column;align-items:center;gap:16px;text-align:center;color:#192b43;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.scikeel-loading-error p{margin:0;font-size:14px;line-height:1.6;color:#65778d}
.scikeel-loading-retry{min-height:40px;border:1px solid #dce5f0;border-radius:8px;background:#fff;padding:0 16px;color:#192b43;font-size:14px;cursor:pointer}
:host([data-theme="dark"]){color-scheme:dark}
:host([data-theme="dark"]) .scikeel-loading{background:#0f1720;color:#e6edf6}
:host([data-theme="dark"]) .scikeel-loading-mark{color:#9fc3f0}
:host([data-theme="dark"]) .scikeel-loading-spinner{color:#8ba1b8}
:host([data-theme="dark"]) .scikeel-loading-error{color:#e6edf6}
:host([data-theme="dark"]) .scikeel-loading-error p{color:#9fb1c4}
:host([data-theme="dark"]) .scikeel-loading-retry{border-color:#2a3a4a;background:#152232;color:#e6edf6}
@keyframes scikeel-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.scikeel-loading-spinner{animation:none}}
`;

export function loadingSurface() {
  return `<div class="scikeel-loading" data-scikeel-boot-gate="1" role="status" aria-busy="true">
<svg class="scikeel-loading-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M25 6H12L6 13H22L26 20L20 26H7M12 6L7 26M25 6L20 26" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<svg class="scikeel-loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/></svg>
</div>`;
}
