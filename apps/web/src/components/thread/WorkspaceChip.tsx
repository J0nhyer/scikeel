import i18n from "@/i18n";

/** Last path segment of the workspace folder, or the localized name when
 *  the path is unknown. Show the folder name as-is, including the managed
 *  workspace root. */
export function baseName(path: string | null): string {
  const fallback = i18n.t("session:workspaceChip.fallbackName");
  if (!path) return fallback;
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || fallback;
}
