import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { useIsMobile } from "@/lib/useIsMobile";
import { useTranslation } from "react-i18next";

export interface WebChoice {
  key: string;
  label: string;
  disabled?: boolean;
  reason?: string;
}

export function WebChoiceMenu({ label, value, choices, onSelect, busy = false, compact = false }: {
  label: string;
  value: string;
  choices: WebChoice[];
  onSelect: (key: string) => void | Promise<void>;
  busy?: boolean;
  compact?: boolean;
}) {
  const mobile = useIsMobile();
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const firstRow = useRef<HTMLButtonElement>(null);
  const selected = choices.find((choice) => choice.key === value);
  const close = () => setOpen(false);
  const button = (
    <button type="button" disabled={busy} aria-label={`${label}: ${selected?.label ?? value}`}
      aria-expanded={open}
      className="flex h-10 min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-surface px-3 text-xs text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50">
      {busy && <Loader2 size={14} className="shrink-0 animate-spin" />}
      {!compact && <span className="shrink-0 text-muted">{label}</span>}
      <span className="truncate font-medium">{selected?.label ?? value}</span>
      <ChevronDown size={14} className="shrink-0 text-muted" />
    </button>
  );
  if (mobile) return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>{button}</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/45" />
      <Dialog.Content aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-[101] max-h-[75dvh] overflow-y-auto rounded-t-lg bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-xl"
        onOpenAutoFocus={(event) => { if (firstRow.current) { event.preventDefault(); firstRow.current.focus(); } }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          // eslint-disable-next-line i18next/no-literal-string -- DOM selector, not user-facing copy.
          const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-choice-row]:not(:disabled)")];
          if (!rows.length) return;
          event.preventDefault();
          const index = rows.indexOf(document.activeElement as HTMLButtonElement);
          rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length].focus();
        }}>
        <div className="mb-2 flex items-center justify-between px-2 font-medium text-text"><Dialog.Title>{label}</Dialog.Title>
          <Dialog.Close className="flex h-10 w-10 items-center justify-center" aria-label={t("composer.model.close")}><X size={18} /></Dialog.Close>
        </div>
        <div className="space-y-1">{choices.map((choice, index) => <button key={choice.key} ref={index === choices.findIndex((item) => !item.disabled) ? firstRow : undefined} data-choice-row
          type="button" disabled={choice.disabled} title={choice.reason} onClick={() => { void onSelect(choice.key); close(); }}
          className="flex min-h-10 w-full items-center justify-between gap-2 rounded px-3 text-left text-sm text-text hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50">
          <span className="min-w-0 truncate">{choice.label}</span>{choice.key === value && <Check size={15} aria-hidden={true} />}
        </button>)}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
  return <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild>{button}</DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align="start" sideOffset={6}
      className="z-[100] max-h-[min(70vh,26rem)] min-w-[14rem] overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lg">
      {choices.map((choice) => <DropdownMenu.Item key={choice.key} disabled={choice.disabled}
        title={choice.reason} onSelect={() => void onSelect(choice.key)}
        className="flex min-h-10 cursor-pointer items-center justify-between gap-2 rounded px-3 text-sm text-text outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50">
        <span className="truncate">{choice.label}</span>{choice.key === value && <Check size={15} aria-hidden={true} />}
      </DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
