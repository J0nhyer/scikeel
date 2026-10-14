import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { hasPendingComposerAttachments, retireComposerAttachments } from "@/components/thread/useComposerAttachments";
import { hasParkedDraft, unparkDraft } from "@/lib/composerStash";
import { findLeaf, useLayoutStore } from "@/lib/layout";
import { draftKeyFor, useRuntimeStore } from "@/lib/runtime";

type PrepareWebDraft = () => Promise<{ path: string } | null>;

/** One replacement flow for the Web's single visible conversation pane. */
export function useWebDraftTransition() {
  const navigate = useNavigate();
  const { t } = useTranslation("nav");
  const locked = useRef(false);
  const mounted = useRef(true);
  const confirm = useRef<((accepted: boolean) => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; confirm.current?.(false); };
  }, []);

  const requestTransition = async (prepare: PrepareWebDraft): Promise<boolean> => {
    if (locked.current || useRuntimeStore.getState().webReadOnly) return false;
    locked.current = true;
    setBusy(true);
    const state = useRuntimeStore.getState();
    const account = state.gatewayUser?.id;
    const assistant = state.gatewayRuntime;
    const layout = useLayoutStore.getState();
    const oldLeaf = layout.tree && layout.focusedLeafId ? findLeaf(layout.tree, layout.focusedLeafId) : null;
    const oldKey = oldLeaf ? draftKeyFor(oldLeaf.id) : null;
    const queueKey = oldKey ? `${account ?? "local"}:${oldKey}` : null;
    try {
      if (oldKey && (hasParkedDraft(oldKey) || (queueKey && hasPendingComposerAttachments(queueKey, oldLeaf?.sessionId)))) {
        setAsking(true);
        const accepted = await new Promise<boolean>((resolve) => { confirm.current = resolve; });
        confirm.current = null;
        if (mounted.current) setAsking(false);
        if (!accepted) return false;
      }
      const destination = await prepare();
      const current = useRuntimeStore.getState();
      const currentLayout = useLayoutStore.getState();
      const currentLeaf = currentLayout.tree && currentLayout.focusedLeafId
        ? findLeaf(currentLayout.tree, currentLayout.focusedLeafId) : null;
      if (!destination || !mounted.current || account !== current.gatewayUser?.id || assistant !== current.gatewayRuntime ||
        layout.focusedLeafId !== currentLayout.focusedLeafId || oldLeaf?.sessionId !== currentLeaf?.sessionId) return false;
      if (oldKey) unparkDraft(oldKey);
      if (queueKey) retireComposerAttachments(queueKey, oldLeaf?.sessionId);
      useLayoutStore.getState().reset(null);
      const leafId = useLayoutStore.getState().focusedLeafId;
      if (!leafId) throw new Error("Could not open a new conversation.");
      // Drop the old session URL before reconnect callbacks can rebind it.
      navigate("/live");
      return await useRuntimeStore.getState().startDraftInWorkspace(destination.path, draftKeyFor(leafId));
    } catch (error) {
      if (mounted.current) useRuntimeStore.setState({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const confirmation = asking ? <ConfirmDialog
    title={t("projects.discardTitle")} body={t("projects.discardBody")}
    confirmLabel={t("projects.discardAction")}
    onConfirm={() => confirm.current?.(true)} onCancel={() => confirm.current?.(false)}
  /> : null;
  return { requestTransition, busy, confirmation };
}
