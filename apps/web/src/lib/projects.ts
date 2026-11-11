import type { ProjectImportMode, ProjectInfo } from "./projectTypes";
import { gatewayGet, gatewayPost } from "./webMode";

/** Create a project folder on the gateway. */
export async function createProject(name: string): Promise<ProjectInfo> {
  const created = await gatewayPost<ProjectInfo>("/v1/projects", { name });
  if (!created) throw new Error("the gateway did not return the new project");
  return created;
}

/** Every project the gateway knows about, sorted by name. */
export async function listProjects(): Promise<ProjectInfo[]> {
  return (await gatewayGet<ProjectInfo[]>("/v1/projects")) ?? [];
}

/** Rename a project's display name (keyed by id; the folder never moves). */
export async function renameProject(id: string, name: string): Promise<void> {
  await gatewayPost(`/v1/projects/${encodeURIComponent(id)}`, { name }, "PATCH");
}

/** Pin/unpin a project to the sidebar. */
export async function setProjectPinned(id: string, pinned: boolean): Promise<void> {
  await gatewayPost(`/v1/projects/${encodeURIComponent(id)}/pin`, { pinned });
}

/** Remove a project from the index. Files on disk are NOT deleted. */
export async function deleteProject(id: string): Promise<void> {
  await gatewayPost(`/v1/projects/${encodeURIComponent(id)}`, {}, "DELETE");
}

/** Local-folder import is a desktop action; the gateway has no host picker. */
export async function importProject(_path: string, _mode: ProjectImportMode): Promise<ProjectInfo> {
  throw new Error("Importing a local folder is not available in the Web client.");
}
