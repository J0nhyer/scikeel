import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);

export class ActiveOwnerStore {
  constructor({ filePath, maxOwners = 1, logger = () => {} } = {}) {
    if (typeof filePath !== "string" || !filePath.startsWith("/") ||
        !Number.isSafeInteger(maxOwners) || maxOwners < 1 || maxOwners > 2) {
      throw new Error("invalid active owner store configuration");
    }
    Object.assign(this, { filePath, maxOwners, logger });
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(value) || value.length > 2) return [];
      return value
        .filter(owner => owner && identifier(owner.userId) && Number.isSafeInteger(owner.since) && owner.since >= 0)
        .sort((a, b) => b.since - a.since)
        .slice(0, this.maxOwners);
    } catch (error) {
      if (error.code !== "ENOENT") this.logger({ type: "owner_store.read_failed" });
      return [];
    }
  }

  async remember(userId, since = Date.now()) {
    if (!identifier(userId) || !Number.isSafeInteger(since) || since < 0) return;
    const owners = await this.read();
    const next = [{ userId, since }, ...owners.filter(owner => owner.userId !== userId)].slice(0, this.maxOwners);
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.filePath);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      this.logger({ type: "owner_store.write_failed" });
    }
  }
}
