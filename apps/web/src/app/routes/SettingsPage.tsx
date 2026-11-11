import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useParams } from "react-router-dom";
import { AppearancePicker } from "@/components/settings/AppearancePicker";
import { useUiStore } from "@/lib/store";
import { shippedLocales } from "@/i18n/config";
import { useRuntimeStore } from "@/lib/runtime";
import { isGatewayWeb } from "@/lib/webMode";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { GatewayModelsPanel } from "@/components/settings/GatewayModelsPanel";
import { Row, Section, Switch } from "@/components/settings/Section";
import { resolveSection } from "@/components/settings/sections";
import { chipCls, inputCls, selectCls } from "@/components/settings/inputCls";
import { cn } from "@/lib/cn";

/**
 * Settings for the Web client. The desktop-only sections (runtime, connectors,
 * browser, computer, compute, remote, memory) were removed with the desktop
 * shell; the gateway exposes the surfaces that remain here.
 */
export function SettingsPage() {
  // Which settings section is on screen — the sidebar is the navigation.
  const section = resolveSection(useParams().section);
  const locale = useUiStore((s) => s.locale);
  const setLocale = useUiStore((s) => s.setLocale);
  const { t } = useTranslation(["settings", "common"]);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const runtimeKind = useRuntimeStore((s) => s.runtimeKind);
  const autoReview = useRuntimeStore((s) => s.autoReview);
  const setAutoReview = useRuntimeStore((s) => s.setAutoReview);
  const stallGuard = useRuntimeStore((s) => s.stallGuard);
  const setStallGuard = useRuntimeStore((s) => s.setStallGuard);
  const wsPath = useRuntimeStore((s) => s.gatewayWorkspace);

  return (
    // `select-none`: Settings is chrome, not a document. Right-clicking or
    // dragging across a label used to leave stray highlight behind; the inputs
    // opt back in globally (see index.css).
    <div className="h-full select-none overflow-y-auto">
      {/* Modest top padding: the AppShell titlebar strip already clears 48px. */}
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-4 sm:px-8">
        <h1 className="font-serif text-2xl text-text">{t(`nav.${section}`)}</h1>

        {/* ---- Per-user runtime on the authenticated cloud platform ---- */}
        {section === "models" && <GatewayModelsPanel />}

        {/* ---- Review ---- */}
        {section === "general" && runtimeKind === "opencode" && (
          <Section title={t("review.title")} hint={t("review.hint")} flush>
            <div className="divide-y divide-faint">
              <Row
                title={t("review.autoTitle")}
                hint={t("review.autoHint")}
                control={
                  <Switch
                    checked={autoReview}
                    onChange={setAutoReview}
                    label={t("review.autoTitle")}
                  />
                }
              />
            </div>
          </Section>
        )}

        {/* ---- Stall guard (#121) ---- */}
        {/* Watch for a turn that looks stuck — silent too long (Channel A) or
            repeating the same tool call with identical results (Channel B) —
            and offer Keep waiting / Stop. Never auto-interrupts. */}
        {section === "general" && (isGatewayWeb || runtimeKind === "opencode") && (
          <Section
            title={t("stall.title")}
            hint={t("stall.hint") + (isGatewayWeb ? ` ${t("stall.webNote")}` : "")}
            flush
          >
            <div className="divide-y divide-faint">
              <Row
                title={t("stall.enableTitle")}
                hint={t("stall.enableHint")}
                control={
                  <Switch
                    checked={stallGuard.enabled}
                    onChange={(on) => setStallGuard({ enabled: on })}
                    label={t("stall.enableTitle")}
                  />
                }
              />
              {stallGuard.enabled && (
                <>
                  {/* Channel A — silence. Presets in minutes; the value shown
                      is whatever the user last chose, preset or custom. */}
                  <Row title={t("stall.silenceLabel")} hint={t("stall.silenceHint")}>
                    <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center sm:gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted">{t("stall.channelA")}</span>
                        <Switch
                          checked={stallGuard.channelAEnabled}
                          onChange={(on) => setStallGuard({ channelAEnabled: on })}
                          label={t("stall.channelA")}
                        />
                      </div>
                      {stallGuard.channelAEnabled && (
                        <SilenceThresholdControl
                          minutes={stallGuard.silenceMinutes}
                          onChange={(m) => setStallGuard({ silenceMinutes: m })}
                          t={t}
                        />
                      )}
                    </div>
                  </Row>
                  {/* Channel B — repetition */}
                  <Row title={t("stall.repeatLabel")}>
                    <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center sm:gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted">{t("stall.channelB")}</span>
                        <Switch
                          checked={stallGuard.channelBEnabled}
                          onChange={(on) => setStallGuard({ channelBEnabled: on })}
                          label={t("stall.channelB")}
                        />
                      </div>
                      {stallGuard.channelBEnabled && (
                        <RepeatThresholdControl
                          threshold={stallGuard.repeatThreshold}
                          onChange={(k) => setStallGuard({ repeatThreshold: k })}
                          t={t}
                        />
                      )}
                    </div>
                  </Row>
                </>
              )}
            </div>
          </Section>
        )}

        {/* ---- Privacy & data flow ---- */}
        {section === "privacy" && <DataFlowCard model={defaultModel} workspace={wsPath} />}

        {/* ---- Appearance ---- */}
        {section === "appearance" && (
          <Section title={t("appearance.title")} flush>
            <div className="divide-y divide-faint">
              <AppearancePicker />
              <Row
                title={t("language.label")}
                control={
                  <select
                    value={locale}
                    onChange={(e) => setLocale(e.target.value)}
                    aria-label={t("language.label")}
                    className={chipCls()}
                  >
                    {shippedLocales().map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.nativeName}
                      </option>
                    ))}
                  </select>
                }
              />
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

/** Preset silence thresholds (Channel A), in minutes. The dropdown offers the
 *  common stops; anything else falls through to a free-form minute input. */
const SILENCE_PRESET_MIN = [10, 30, 60, 180, 600] as const;

/** Preset repetition counts (Channel B). */
const REPEAT_PRESETS = [3, 5, 10, 30] as const;

/** Render a minute value readably: whole hours as "n h", otherwise "n min". */
function formatMinutes(minutes: number, t: TFunction<["settings", "common"]>): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60} ${t("stall.hoursUnit")}`;
  }
  return `${minutes} ${t("stall.silenceUnit")}`;
}

/** Channel A's threshold picker: preset dropdown + free-form minutes when the
 *  user picks "Custom…" (or the stored value is not a preset). Input is
 *  clamped to [1, 1440] minutes so a stray keystroke or hostile value cannot
 *  break the feature (0 would warn instantly; a huge value would never warn).
 *
 *  "Custom…" is a real UI mode, not derived from the value alone: picking it
 *  shows the free-form input even while the current value still matches a
 *  preset (otherwise the select would snap back the instant it was opened).
 *  Once in custom mode, typing a value that happens to equal a preset does NOT
 *  kick you out — the user is mid-edit and the input must not vanish under
 *  their cursor. Choosing an explicit preset option is what leaves custom mode. */
function SilenceThresholdControl({
  minutes,
  onChange,
  t,
}: {
  minutes: number;
  onChange: (minutes: number) => void;
  t: TFunction<["settings", "common"]>;
}) {
  const [customMode, setCustomMode] = useState(
    !(SILENCE_PRESET_MIN as readonly number[]).includes(minutes),
  );
  return (
    <div className="flex items-center gap-2">
      <select
        className={selectCls("h-8 w-[130px]")}
        value={customMode ? "custom" : String(minutes)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") setCustomMode(true);
          else {
            setCustomMode(false);
            onChange(Number(v));
          }
        }}
        aria-label={t("stall.silenceLabel")}
      >
        {SILENCE_PRESET_MIN.map((m) => (
          <option key={m} value={m}>
            {formatMinutes(m, t)}
          </option>
        ))}
        <option value="custom">{t("stall.custom")}</option>
      </select>
      {customMode && (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={1440}
            value={minutes}
            onChange={(e) => {
              const raw = Number(e.target.value);
              onChange(Number.isFinite(raw) ? Math.max(1, Math.min(1440, raw)) : 1);
            }}
            className={cn(inputCls("w-20 text-right"), "pr-2")}
            aria-label={t("stall.silenceCustomHint")}
            title={t("stall.silenceCustomHint")}
          />
          <span className="shrink-0 text-xs text-muted">{t("stall.silenceUnit")}</span>
        </div>
      )}
    </div>
  );
}

/** Channel B's threshold picker: preset dropdown + free-form count when the
 *  user picks "Custom…". Clamped to [2, 100] — below 2 is not a "repeat", and
 *  above 100 the guard would effectively never fire. Same custom-mode rules as
 *  the silence picker above. */
function RepeatThresholdControl({
  threshold,
  onChange,
  t,
}: {
  threshold: number;
  onChange: (threshold: number) => void;
  t: TFunction<["settings", "common"]>;
}) {
  const [customMode, setCustomMode] = useState(
    !(REPEAT_PRESETS as readonly number[]).includes(threshold),
  );
  return (
    <div className="flex items-center gap-2">
      <select
        className={selectCls("h-8 w-[110px]")}
        value={customMode ? "custom" : String(threshold)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") setCustomMode(true);
          else {
            setCustomMode(false);
            onChange(Number(v));
          }
        }}
        aria-label={t("stall.repeatLabel")}
      >
        {REPEAT_PRESETS.map((k) => (
          <option key={k} value={k}>
            {k} {t("stall.repeatUnit")}
          </option>
        ))}
        <option value="custom">{t("stall.custom")}</option>
      </select>
      {customMode && (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={2}
            max={100}
            value={threshold}
            onChange={(e) => {
              const raw = Number(e.target.value);
              onChange(Number.isFinite(raw) ? Math.max(2, Math.min(100, raw)) : 2);
            }}
            className={cn(inputCls("w-16 text-right"), "pr-2")}
            aria-label={t("stall.repeatCustomHint")}
            title={t("stall.repeatCustomHint")}
          />
          <span className="shrink-0 text-xs text-muted">{t("stall.repeatUnit")}</span>
        </div>
      )}
    </div>
  );
}
