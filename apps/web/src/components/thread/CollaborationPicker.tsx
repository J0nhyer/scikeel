import { useTranslation } from "react-i18next";
import type { CollaborationMode } from "@/lib/collaboration";
import { WebChoiceMenu } from "./WebChoiceMenu";
const modes = ["guided", "collaborative", "delegated", "autonomous"] as const;
export function CollaborationPicker({
  mode,
  disabled,
  onSelect,
}: {
  mode: CollaborationMode;
  disabled: boolean;
  onSelect: (mode: CollaborationMode) => unknown | Promise<unknown>;
}) {
  const { t } = useTranslation("session");
  return (
    <WebChoiceMenu
      label={t("collaboration.label")}
      value={mode}
      busy={disabled}
      compact
      choices={modes.map((key) => ({
        key,
        label: t(`collaboration.modes.${key}`),
      }))}
      onSelect={(value) => {
        void onSelect(value as CollaborationMode);
      }}
    />
  );
}
