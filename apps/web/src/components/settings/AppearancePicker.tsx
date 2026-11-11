import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { APPEARANCE_CHOICES } from "@/lib/appearance";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/cn";

export function AppearancePicker() {
  const { t } = useTranslation("settings");
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const decoration = useUiStore((s) => s.campusDecoration);
  const setDecoration = useUiStore((s) => s.setCampusDecoration);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <div className="min-w-0 p-5">
    <div role="radiogroup" aria-label={t("appearance.themeLabel")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {APPEARANCE_CHOICES.map((choice, index) => <button
        type="button" role="radio" key={choice} aria-checked={theme === choice}
        tabIndex={theme === choice || (theme === "warm" && index === 0) ? 0 : -1}
        ref={(element) => { buttons.current[index] = element; }}
        onClick={() => setTheme(choice)}
        onKeyDown={(event) => {
          if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? 3 :
            (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + 4) % 4;
          setTheme(APPEARANCE_CHOICES[next]); buttons.current[next]?.focus();
        }}
        className={cn("min-w-0 rounded-xl border p-2 text-left outline-offset-4 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
          theme === choice ? "border-accent ring-1 ring-accent" : "border-border hover:border-muted")}
      >
        <div className={cn("appearance-preview", `appearance-preview-${choice}`)} aria-hidden="true">
          <div className="appearance-preview-sidebar"><i /><i /><i /></div>
          <div className="appearance-preview-content"><i /><i /><b /></div>
        </div>
        <div className="flex items-center justify-between gap-1 px-1 pb-1 pt-3 text-xs font-medium">
          <span>{t(`appearance.theme.${choice}`)}</span>
          <span aria-hidden="true" className={cn("h-3 w-3 shrink-0 rounded-full border", theme === choice ? "border-accent bg-accent" : "border-border")} />
        </div>
      </button>)}
    </div>
    <p className="mt-4 rounded-lg bg-surface-2 px-4 py-3 text-xs leading-relaxed text-muted" role="status">{t(`appearance.summary.${theme}`)}</p>
    {theme === "cdut" && <div className="mt-5 flex items-center justify-between gap-4">
      <div><div className="text-xs font-medium">{t("appearance.campusDecoration.label")}</div><p className="mt-1 text-xs leading-relaxed text-muted">{t("appearance.campusDecoration.hint")}</p></div>
      <button type="button" role="switch" aria-checked={decoration} aria-label={t("appearance.campusDecoration.label")}
        onClick={() => setDecoration(!decoration)}
        className={cn("relative h-6 w-10 shrink-0 rounded-full p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent", decoration ? "bg-accent" : "bg-muted")}
      ><span className={cn("block h-4 w-4 rounded-full bg-white", decoration && "translate-x-4")} /></button>
    </div>}
  </div>;
}
