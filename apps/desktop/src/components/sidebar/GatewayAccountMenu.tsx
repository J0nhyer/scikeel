import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect } from "react";
import { ChevronUp, LogOut, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { GatewayUser } from "@/lib/runtime";
import { useRuntimeStore } from "@/lib/runtime";

export function GatewayAccountMenu({ user }: {
  user: GatewayUser | null;
}) {
  const { t } = useTranslation("nav");
  const navigate = useNavigate();
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      const state = useRuntimeStore.getState();
      if (state.status === "ready" && !state.gatewayRuntimeSwitching && !state.modelSwitching) void state.refreshGatewayRuntimes();
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [userId]);
  if (!user) return null;
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger className="flex min-h-12 w-full items-center gap-3 border-t border-border px-3 text-left text-sm text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      aria-label={t("sidebar.account", { username: user.username })}>
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 font-semibold text-text">{Array.from(user.username)[0]?.toLocaleUpperCase() ?? "?"}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{user.username}</span>
      {user.role === "admin" && <span className="shrink-0 text-xs text-muted">{t("sidebar.adminBadge")}</span>}
      <ChevronUp size={14} className="shrink-0 text-muted" />
    </DropdownMenu.Trigger>
    {/* eslint-disable-next-line i18next/no-literal-string -- Radix placement enum. */}
    <DropdownMenu.Portal><DropdownMenu.Content align="start" side="top" sideOffset={4}
      className="z-[100] w-[var(--radix-dropdown-menu-trigger-width)] min-w-44 rounded-md border border-border bg-surface p-1 shadow-lg">
      <DropdownMenu.Item onSelect={() => navigate("/settings/models")}
        className="flex min-h-10 cursor-pointer items-center gap-2 rounded px-3 text-sm text-text outline-none data-[highlighted]:bg-surface-2">
        <Settings size={15} /> {t("sidebar.settings")}
      </DropdownMenu.Item>
      {/* Keep the form mounted until the browser submits it and navigates away. */}
      <form method="post" action="/auth/logout"><DropdownMenu.Item asChild onSelect={(event) => event.preventDefault()}>
        <button type="submit" className="flex min-h-10 w-full cursor-pointer items-center gap-2 rounded px-3 text-left text-sm text-text outline-none data-[highlighted]:bg-surface-2">
          <LogOut size={15} /> {t("sidebar.signOut")}
        </button>
      </DropdownMenu.Item></form>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
