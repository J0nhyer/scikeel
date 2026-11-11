import type { ReactNode } from "react";

/**
 * Split button. The Web client has no host folder picker and no terminal, so
 * there is nothing to ask: the button splits on the click and the new pane
 * makes its own workspace on first send.
 */
export function SplitMenu({
  onSplit,
  icon,
  label,
}: {
  /** Kept for callers that still describe the source pane. */
  sourceFolder?: string | null;
  onSplit: (folder: string | null) => void;
  /** Kept for callers from the desktop UI. */
  onSplitTerminal?: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={() => onSplit(null)}
      className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
      title={label}
      aria-label={label}
    >
      {icon}
    </button>
  );
}
