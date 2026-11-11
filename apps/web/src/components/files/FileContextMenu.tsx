import * as ContextMenu from "@radix-ui/react-context-menu";
import { Copy, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileRoot } from "@ai4s/shared";
import { downloadArtifact, type DirEntry } from "@/lib/artifactFile";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

async function copy(text: string, what: string) {
  try {
    await copyText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Could not copy to the clipboard.");
  }
}

/** Right-click menu for a file/dir row in the Web explorer: copy its
 *  workspace-relative path or download it. */
export function FileContextMenu({
  entry,
  root,
  directory,
  children,
}: {
  entry: DirEntry;
  root: FileRoot;
  directory?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(["pages", "common", "inspector"]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[190px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop">
          <Item
            icon={<Copy size={14} />}
            onSelect={() => void copy(entry.path, t("files.contextMenu.relativePathLabel"))}
          >
            {t("files.contextMenu.copyRelativePath")}
          </Item>
          {!entry.isDir && (
            <Item
              icon={<Download size={14} />}
              onSelect={() =>
                void downloadArtifact(entry.path, root, directory).catch((e: unknown) =>
                  toast.error(e instanceof Error ? e.message : String(e)),
                )
              }
            >
              {t("inspector:filePreview.download")}
            </Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Item({
  icon,
  children,
  onSelect,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-input px-2 py-1.5 outline-none",
        "data-[highlighted]:bg-surface-2",
      )}
    >
      <span className="shrink-0 text-muted">{icon}</span>
      {children}
    </ContextMenu.Item>
  );
}
