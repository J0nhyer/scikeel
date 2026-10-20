import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LogOut } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { signOutPlatformBrowser } from "@/lib/runtime";
import { useToastStore } from "@/lib/toast";
import { isPlatformWeb } from "@/lib/webMode";

export function GatewaySignOut({ inMenu = false }: { inMenu?: boolean }) {
  const { t } = useTranslation(["nav", "session"]);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submitSignOut = async (event: FormEvent<HTMLFormElement>) => {
    if (!isPlatformWeb) { useToastStore.getState().reset(); return; }
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true); setError(false);
    try { await signOutPlatformBrowser(); }
    catch { if (mounted.current) setError(true); }
    finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const button = <button type="submit" disabled={pending} aria-busy={pending}
    className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded px-3 text-left text-sm text-text outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent data-[highlighted]:bg-surface-2 disabled:cursor-wait disabled:opacity-60">
    <LogOut size={15} aria-hidden={true} /> {t(pending ? "nav:sidebar.signingOut" : "nav:sidebar.signOut")}
  </button>;
  return <form method="post" action="/auth/logout" onSubmit={event => { void submitSignOut(event); }}>
    {inMenu ? <DropdownMenu.Item asChild onSelect={event => event.preventDefault()}>{button}</DropdownMenu.Item> : button}
    {error && <p role="alert" className="px-3 py-2 text-xs text-danger">{t("session:live.account.signOutFailed")}</p>}
  </form>;
}
