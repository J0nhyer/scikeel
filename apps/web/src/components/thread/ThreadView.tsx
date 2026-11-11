import { Link } from "react-router-dom";
import { PanelLeft, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Session } from "@ai4s/shared";
import { useUiStore } from "@/lib/store";
import { BlockList } from "./BlockList";

export function ThreadView({ session }: { session: Session }) {
  const { t } = useTranslation(["session", "common"]);
  const isExample = session.group === "Examples";

  // The header doubles as the titlebar (see AppShell.pageOwnsTitlebar), so it
  // mirrors LiveSessionPage's header exactly — one fixed-height row that clears
  // the macOS traffic lights and re-expands the sidebar when collapsed. Without
  // this the AppShell fallback strip would stack on top and the bar would read
  // as double height.
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();
  const isMac = navigator.userAgent.includes("Mac");

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-faint px-6">
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            aria-label={t("live.header.expandSidebarAria")}
            title={t("live.header.expandSidebarTitle", { shortcut: isMac ? "⌘B" : "Ctrl+B" })}
            className="fade-in rounded p-1 text-text hover:bg-surface-2"
          >
            <PanelLeft size={14} strokeWidth={1.5} />
          </button>
        )}
        <h1 className="min-w-0 truncate text-[13px] font-medium text-text">{session.title}</h1>
        {isExample && (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted ring-1 ring-border">
            {t("thread.exampleBadge")}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* Document content: keeps the browser's own selection and copy behavior. */}
        <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-8 py-6" data-native-menu>
          <BlockList blocks={session.blocks} />
        </div>
      </div>
      <div className="px-8 pb-5 pt-2">
        <div className="mx-auto flex max-w-[760px] items-center gap-3 rounded-card border border-border bg-surface-2/60 px-4 py-3 text-sm text-muted">
          <Sparkles size={16} className="text-accent" />
          <span>{t("thread.sampleNotice")}</span>
          <Link
            to="/live"
            className="ml-auto rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
          >
            {t("starters.newSession")}
          </Link>
        </div>
      </div>
    </div>
  );
}
