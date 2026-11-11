import { LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";

/** A plain browser form keeps logout reliable even if the React runtime is in
 *  an error state: the platform revokes the session cookie and redirects. */
export function PlatformLogoutButton() {
  const { t } = useTranslation("nav");

  return (
    <form method="post" action="/auth/logout">
      <button
        type="submit"
        className="flex items-center gap-2 rounded-input px-2 py-1 text-[13px] text-muted hover:bg-surface-2 hover:text-text"
        aria-label={t("sidebar.signOut")}
        title={t("sidebar.signOut")}
      >
        <LogOut size={15} />
        <span>{t("sidebar.signOut")}</span>
      </button>
    </form>
  );
}
