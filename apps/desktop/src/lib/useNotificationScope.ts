import { useLayoutEffect } from "react";
import { useRuntimeStore } from "./runtime";
import { useToastStore } from "./toast";
import { isGatewayWeb } from "./webMode";
export function useNotificationScope() {
  const account = useRuntimeStore(s => s.gatewayUser?.id ?? null);
  useLayoutEffect(() => {
    if (isGatewayWeb) useToastStore.getState().setAccount(account);
    const prune = () => useToastStore.getState().pruneExpired();
    document.addEventListener("visibilitychange", prune);
    window.addEventListener("pageshow", prune); window.addEventListener("focus", prune);
    prune();
    return () => {
      document.removeEventListener("visibilitychange", prune);
      window.removeEventListener("pageshow", prune); window.removeEventListener("focus", prune);
    };
  }, [account]);
}
