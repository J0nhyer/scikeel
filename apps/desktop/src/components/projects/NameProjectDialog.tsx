import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

/** Modal for naming a new (from-scratch) project: a focused, pre-selected input
 *  with Save/Cancel. Used instead of an inline row so "New project" reads as a
 *  deliberate step (matching the from-scratch / existing-folder menu split). */
export function NameProjectDialog({
  defaultName,
  title,
  subtitle,
  placeholder,
  busy,
  onSave,
  onCancel,
  error,
  created = false,
  inputDisabled = false,
  cancelDisabled = false,
}: {
  defaultName: string;
  title: string;
  subtitle: string;
  placeholder?: string;
  busy: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
  error?: string;
  created?: boolean;
  inputDisabled?: boolean;
  cancelDisabled?: boolean;
}) {
  const { t } = useTranslation(["common", "nav"]);
  const [name, setName] = useState(defaultName);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = () => {
    const v = name;
    if (v.trim() && !busy) onSave(v);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={() => !busy && !cancelDisabled && onCancel()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={title}
        className="w-[420px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-text">{title}</div>
        <p className="mt-1 text-sm text-muted">{subtitle}</p>
        <input
          ref={ref}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          disabled={busy || created || inputDisabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            else if (e.key === "Escape" && !busy && !cancelDisabled) onCancel();
          }}
          className={cn(
            "mt-4 w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent",
            busy && "animate-pulse opacity-60",
          )}
        />
        {error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2 disabled:opacity-50"
            onClick={onCancel}
            disabled={busy || cancelDisabled}
          >
            {t("actions.cancel")}
          </button>
          <button
            className="rounded-input bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            onClick={save}
            disabled={busy || !name.trim()}
          >
            {created ? t("nav:projects.retryOpening") : t("actions.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
