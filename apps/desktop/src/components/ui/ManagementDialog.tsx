import { useRef, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/cn";

const disabledSelector = ":disabled";

export function ManagementDialog({
  title, description, children, onClose, dismissible = true,
  initialFocusRef, returnFocusRef, role = "dialog", className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFocusRef?: RefObject<HTMLElement>;
  role?: "dialog" | "alertdialog";
  className?: string;
}) {
  const opener = useRef(document.activeElement);
  return <Dialog.Root open onOpenChange={open => { if (!open && dismissible) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
      <Dialog.Content
        role={role}
        aria-modal={true}
        className={cn("fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-32px)] w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-border bg-surface p-5 text-text shadow-card [overflow-wrap:anywhere]", className)}
        onOpenAutoFocus={event => {
          const target = initialFocusRef?.current;
          if (target && !target.matches(disabledSelector)) { event.preventDefault(); target.focus(); }
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const target = returnFocusRef?.current ?? opener.current;
          if (target instanceof HTMLElement && target.isConnected) target.focus();
        }}
        onEscapeKeyDown={event => { if (!dismissible) event.preventDefault(); }}
        onInteractOutside={event => { if (!dismissible) event.preventDefault(); }}
      >
        <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
        <Dialog.Description className={description ? "mt-1 text-sm text-muted" : "sr-only"}>{description ?? title}</Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
