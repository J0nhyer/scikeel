import type { ThreadBlock } from "@ai4s/shared";

const KEY_TITLE = /(?:analysis\.py|ml_analysis\.py|report\.md|review\.md|references\.csv|search_log\.md|draft_references\.md)/;

/** Keep the blocks a reader needs to follow the run: prompts, answers, key
 *  tool calls, artifacts, and completed review findings. Drop runtime
 *  internals, reasoning, live progress, failed branches, and timestamps. */
export function trimBlocks(blocks: ThreadBlock[]): ThreadBlock[] {
  const seenTitles = new Set<string>();
  return blocks
    .filter((block) => {
      if (block.kind === "reasoning" || block.kind === "compaction" ||
          block.kind === "history-repair" || block.kind === "running-jobs") return false;
      if (block.kind === "status-line") return block.tone === "done" || block.tone === "review";
      if (block.kind === "tool-call") {
        if (block.status !== "success" && block.status !== "warning") return false;
        const key = `${block.tool ?? ""}:${block.title}`;
        if (!block.tool || (block.tool !== "skill" && block.tool !== "research_delivery" && !KEY_TITLE.test(block.title))) return false;
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      }
      return true;
    })
    .map((block) => {
      if (block.kind === "agent") return { kind: "agent", markdown: block.markdown };
      if (block.kind === "user") return { kind: "user", text: block.text, ...(block.attachments ? { attachments: block.attachments } : {}) };
      if (block.kind === "tool-call") {
        const rest = { ...block };
        delete (rest as { callId?: string }).callId;
        return rest;
      }
      if (block.kind === "status-line") return { kind: "status-line", text: block.text, tone: block.tone, ...(block.divider ? { divider: true } : {}) };
      return block;
    });
}

/** Rewrite worker paths and identifiers so a captured run can ship as a
 *  public fixture. Public URLs, filenames, and citation identifiers stay. */
export function redactExampleText(text: string): string {
  return text
    .replace(/\/srv\/scikeel\/data\/workers\/(?:instances\/)?(?:user-)?usr_[A-Za-z0-9]+\/workspace\/?/g, "")
    .replace(/\/srv\/scikeel\/[^\s"'`)\]]*/g, (match) => match.split("/").filter(Boolean).pop() ?? match)
    .replace(/\b(?:user-)?usr_[A-Za-z0-9]+\b/g, "user")
    .replace(/\binstanceId\b/g, "instance")
    .replace(/https?:\/\/(?:172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|10\.\d+\.\d+\.\d+|127\.0\.0\.1|localhost|broker)(?::\d+)?[^\s"'`)\]]*/g, "[internal-url]");
}
