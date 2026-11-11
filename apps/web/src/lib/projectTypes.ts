/** A project row shared by the Web client and the runtime store. */
export interface ProjectInfo {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  /** Absolute workspace folder (canonical, matches session `directory`). */
  path: string;
  /** True when this project was brought in from elsewhere. */
  imported: boolean;
  /** Where an imported project was brought in from. */
  importedFrom?: string;
  /** Whether an imported project is a managed copy or used in place. */
  importMode?: ProjectImportMode;
  pinned: boolean;
}

/** How an imported folder becomes a project. */
export type ProjectImportMode = "copy" | "in-place";

export type ApprovalMode = "approve" | "full";

export type ProxyMode = "system" | "custom" | "none";

export interface ToolStatus {
  name: string;
  found: boolean;
  version?: string | null;
  /** The app's own copy (bundled uv / managed Jupyter env), not one on PATH. */
  managed?: boolean;
}
