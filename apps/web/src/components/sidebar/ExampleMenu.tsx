import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { EXAMPLE_META, type ExampleMeta } from "@/lib/examples";

/** One sidebar row that opens the read-only examples. The row is the only
 *  examples surface outside History; empty metadata renders nothing. */
export function ExampleMenu({ examples = EXAMPLE_META }: { examples?: ExampleMeta[] }) {
  const { t } = useTranslation("nav");
  const navigate = useNavigate();
  if (examples.length === 0) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex w-full items-center gap-2 rounded-input px-2 py-1 text-left text-[13px] text-text hover:bg-surface-2">
          <span className="text-text"><Sparkles size={16} /></span>
          <span>{t("items.examples")}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 max-w-[calc(100vw-24px)] min-w-[260px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
        >
          {examples.map((example) => (
            <DropdownMenu.Item
              key={example.id}
              onSelect={() => navigate(`/example/${example.id}`)}
              className="flex cursor-pointer flex-col gap-0.5 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
            >
              <span className="flex items-center gap-2">
                <span className="truncate font-medium">{example.title}</span>
                <span className="ml-auto shrink-0 rounded-full bg-surface-2 px-1.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                  {t("examples.readOnly")}
                </span>
              </span>
              <span className="text-xs leading-snug text-muted">{example.summary}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
