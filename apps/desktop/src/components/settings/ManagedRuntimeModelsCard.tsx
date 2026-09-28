import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "@/components/settings/Section";
import { inputCls, selectCls } from "@/components/settings/inputCls";
import { cn } from "@/lib/cn";
import { gatewayOrigin } from "@/lib/webMode";

type ManagedRuntimeId = "claude" | "codex";

interface ManagedRuntimeConfig {
  models: string[];
  defaultModel: string | null;
}

interface RuntimeDraft {
  modelsText: string;
  defaultModel: string;
}

interface AdminRuntimeResponse {
  managedRuntimes?: Partial<Record<ManagedRuntimeId, ManagedRuntimeConfig>>;
}

const RUNTIMES: ReadonlyArray<{ id: ManagedRuntimeId; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

const emptyDraft = (): RuntimeDraft => ({ modelsText: "", defaultModel: "" });

function normalizeModels(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((model) => model.trim()).filter(Boolean))];
}

function draftFromConfig(config?: ManagedRuntimeConfig): RuntimeDraft {
  const models = Array.isArray(config?.models) ? config.models : [];
  const defaultModel =
    typeof config?.defaultModel === "string" && models.includes(config.defaultModel)
      ? config.defaultModel
      : (models[0] ?? "");
  return { modelsText: models.join("\n"), defaultModel };
}

async function errorDetail(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
}

export function ManagedRuntimeModelsCard() {
  const { t } = useTranslation("settings");
  const [drafts, setDrafts] = useState<Record<ManagedRuntimeId, RuntimeDraft>>({
    claude: emptyDraft(),
    codex: emptyDraft(),
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<ManagedRuntimeId, boolean>>({
    claude: false,
    codex: false,
  });
  const [messages, setMessages] = useState<Partial<Record<ManagedRuntimeId, string>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch(`${gatewayOrigin()}/api/admin/runtime`, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorDetail(response));
        return response.json() as Promise<AdminRuntimeResponse>;
      })
      .then((payload) => {
        if (!active) return;
        setDrafts({
          claude: draftFromConfig(payload.managedRuntimes?.claude),
          codex: draftFromConfig(payload.managedRuntimes?.codex),
        });
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const changeModels = (runtime: ManagedRuntimeId, modelsText: string) => {
    setDrafts((current) => {
      const models = normalizeModels(modelsText);
      const previousDefault = current[runtime].defaultModel;
      return {
        ...current,
        [runtime]: {
          modelsText,
          defaultModel: models.includes(previousDefault) ? previousDefault : (models[0] ?? ""),
        },
      };
    });
    setMessages((current) => ({ ...current, [runtime]: undefined }));
  };

  const save = async (runtime: ManagedRuntimeId, label: string) => {
    const draft = drafts[runtime];
    const models = normalizeModels(draft.modelsText);
    const defaultModel = models.includes(draft.defaultModel)
      ? draft.defaultModel
      : (models[0] ?? null);
    setSaving((current) => ({ ...current, [runtime]: true }));
    setMessages((current) => ({ ...current, [runtime]: undefined }));
    try {
      const response = await fetch(`${gatewayOrigin()}/api/admin/runtime`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtime, models, defaultModel }),
      });
      if (!response.ok) throw new Error(await errorDetail(response));
      setDrafts((current) => ({
        ...current,
        [runtime]: { modelsText: models.join("\n"), defaultModel: defaultModel ?? "" },
      }));
      setMessages((current) => ({
        ...current,
        [runtime]: t("managedModels.saved", { runtime: label }),
      }));
    } catch (error) {
      setMessages((current) => ({
        ...current,
        [runtime]: t("managedModels.failed", {
          runtime: label,
          detail: error instanceof Error ? error.message : String(error),
        }),
      }));
    } finally {
      setSaving((current) => ({ ...current, [runtime]: false }));
    }
  };

  return (
    <Section
      title={t("managedModels.title")}
      hint={t("managedModels.hint")}
      action={loading ? <Loader2 size={14} className="animate-spin text-muted" aria-hidden /> : undefined}
      flush
    >
      {loadError && (
        <p className="border-b border-faint px-4 py-3 text-[13px] text-error" role="alert">
          {t("managedModels.failed", { runtime: "Managed CLI", detail: loadError })}
        </p>
      )}
      {RUNTIMES.map(({ id, label }, index) => {
        const draft = drafts[id];
        const models = normalizeModels(draft.modelsText);
        return (
          <div key={id} className={cn("px-4 py-4", index > 0 && "border-t border-faint")}>
            <label className="block" htmlFor={`managed-${id}-models`}>
              <span className="text-[13px] font-medium text-text">
                {t("managedModels.enabled", { runtime: label })}
              </span>
              <span className="mt-0.5 block text-xs text-muted">
                {t("managedModels.enabledHint")}
              </span>
            </label>
            <textarea
              id={`managed-${id}-models`}
              aria-label={t("managedModels.enabled", { runtime: label })}
              value={draft.modelsText}
              onChange={(event) => changeModels(id, event.target.value)}
              disabled={loading || saving[id]}
              spellCheck={false}
              className={inputCls("mt-2 h-28 w-full resize-y py-2 font-mono leading-5")}
            />
            {models.length === 0 && (
              <p className="mt-1.5 text-xs text-muted">{t("managedModels.empty")}</p>
            )}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1" htmlFor={`managed-${id}-default`}>
                <span className="mb-1 block text-xs text-muted">
                  {t("managedModels.default", { runtime: label })}
                </span>
                <select
                  id={`managed-${id}-default`}
                  aria-label={t("managedModels.default", { runtime: label })}
                  value={draft.defaultModel}
                  onChange={(event) => {
                    setDrafts((current) => ({
                      ...current,
                      [id]: { ...current[id], defaultModel: event.target.value },
                    }));
                    setMessages((current) => ({ ...current, [id]: undefined }));
                  }}
                  disabled={loading || saving[id] || models.length === 0}
                  className={selectCls("w-full font-mono")}
                >
                  {models.length === 0 ? (
                    <option value="">—</option>
                  ) : (
                    models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void save(id, label)}
                disabled={loading || saving[id]}
                className={cn(
                  "flex h-9 w-full shrink-0 items-center justify-center gap-1.5 rounded-input bg-accent px-3.5",
                  "text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent/90",
                  "disabled:bg-accent/50 sm:w-auto",
                )}
              >
                {saving[id] ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {t("managedModels.save", { runtime: label })}
              </button>
            </div>
            {messages[id] && (
              <p className="mt-2 text-xs text-muted" aria-live="polite">
                {messages[id]}
              </p>
            )}
          </div>
        );
      })}
    </Section>
  );
}
