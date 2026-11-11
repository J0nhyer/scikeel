import { useTranslation } from "react-i18next";
import { useLayoutStore, type PaneContent } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { extOf } from "@/lib/artifacts";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { FilesPage } from "@/app/routes/FilesPage";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { isPlatformWeb } from "@/lib/webMode";
import { confirmWorkspaceDraftLeave } from "@/lib/workspaceDrafts";
const accountScope = {kind:"account"} as const;

/**
 * A pane holding something that is not a conversation: a terminal, the file
 * tree, a notebook, an edited file, a web page.
 *
 * Most of these surfaces already HAVE a header — the notebook's carries its
 * kernel, save state and history; the file tree carries its breadcrumbs — so
 * this adds none and hands them `onClose` instead. Wrapping them gave every
 * pane two stacked title bars, which is what the reported "好几层 Header" was.
 */
export function ContentPane({
  content,
  onClose,
}: {
  content: PaneContent;
  leafId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["session", "nav"]);
  const showDocumentPane = useLayoutStore((s) => s.showDocumentPane);
  const gatewayWorkspace = useRuntimeStore((s) => s.gatewayWorkspace);

  switch (content.kind) {
    case "files":
      return (
        <FilesPage
          onClose={onClose}
          // A file opens BESIDE the tree, not on top of it: the whole reason
          // the browser is a pane is that you keep browsing while you read.
          // `base`, because that is the tree these paths came from. Opening
          // them as workspace-relative made every click report "file not
          // found": the two roots only coincide for the active session.
          //
          // ONE pane for files, reused on every click: a pane per click left
          // the tree fighting a row of slivers for the width.
          onOpenFile={(entry) =>
            showDocumentPane(
              /* eslint-disable i18next/no-literal-string -- PaneContent kinds and FileRoot, not UI copy */
              extOf(entry.name) === "ipynb"
                ? { kind: "notebook", path: entry.path, root: "base" }
                : { kind: "editor", path: entry.path, root: "base" },
              /* eslint-enable i18next/no-literal-string */
            )
          }
        />
      );

    case "notebook":
      return (
        <NotebookEditor path={content.path} root={content.root} onClose={onClose} compactHeader />
      );

    case "editor":
      return (
        <FilePreviewInspector
          data={{
            variant: "file",
            path: content.path,
            filename: baseName(content.path),
            // eslint-disable-next-line i18next/no-literal-string -- artifact kind, not UI copy
            artifact: "report",
            root: content.root,
          }}
          workspaceScope={isPlatformWeb?accountScope:undefined}
          workspaceDirectory={isPlatformWeb?gatewayWorkspace??undefined:undefined}
          onClose={()=>{if(!isPlatformWeb || confirmWorkspaceDraftLeave(t("nav:fileManagement.discardDraft"),accountScope,content.path))onClose();}}
          compactHeader
          // An editor pane opens IN edit mode. Arriving read-only with a pencil
          // to hunt for made it read as a preview that happens to be editable,
          // which is not what "open the file" means.
          startEditing
        />
      );
  }
}

function baseName(path: string): string {
  return path.split("/").pop() || path;
}
