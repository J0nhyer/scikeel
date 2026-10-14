import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { hasDefaultSessionTitle, type SessionMeta } from "@ai4s/sdk";
import { isGatewayWeb } from "./webMode";

// Deduplicate expiry reads across sidebar/history/panes; contains only IDs/clocks.
const refreshed = new Map<string, number>();

export function editableSessionTitle(session?: SessionMeta): string {
  if (!session) return "";
  return isGatewayWeb && hasDefaultSessionTitle(session) ? session.titlePresentation?.fallback ?? "" : session.title;
}

export function useSessionTitles(sessions: readonly SessionMeta[], refresh?: () => Promise<void>) {
  const { t } = useTranslation("nav");
  const [clock, setClock] = useState(Date.now);
  const deadlines = isGatewayWeb ? sessions
    .filter(s => s.titlePresentation?.status === "pending" && hasDefaultSessionTitle(s))
    .map(s => [s.id, s.titlePresentation!.pendingUntil ?? 0] as const) : [];
  const deadlineKey = JSON.stringify(deadlines);
  useEffect(() => {
    const entries = JSON.parse(deadlineKey) as Array<[string, number]>;
    const now = Date.now();
    const next = Math.min(...entries.map(([, until]) => until).filter(until => until > now));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => {
      setClock(Date.now());
      const expired = entries.filter(([id, until]) => until <= Date.now() && refreshed.get(id) !== until);
      if (expired.length && refresh) {
        for (const [id, until] of expired) refreshed.set(id, until);
        while (refreshed.size > 128) refreshed.delete(refreshed.keys().next().value!);
        void refresh().catch(() => {});
      }
    }, Math.min(next - now + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [deadlineKey, refresh, clock]);

  return useCallback((session?: SessionMeta): string | undefined => {
    if (!session) return;
    if (!isGatewayWeb || !hasDefaultSessionTitle(session)) return session.title;
    const presentation = session.titlePresentation;
    if (presentation?.status === "pending" && (presentation.pendingUntil ?? 0) > Math.max(clock, Date.now()))
      return t("history.titleGenerating");
    return presentation?.fallback ?? t("history.titleUntitled");
  }, [clock, t]);
}
