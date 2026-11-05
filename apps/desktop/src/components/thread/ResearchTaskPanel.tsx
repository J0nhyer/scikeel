import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, ChevronDown } from "lucide-react";
import { researchPageId, researchRequest, type ResearchBrief, type ResearchMode, type ResearchTask } from "@/lib/research";

interface Props {
  sessionId: string | null;
  visible: boolean;
  disabled: boolean;
  onStart: (brief: ResearchBrief) => Promise<void>;
  onContinue: () => Promise<void> | void;
  onStop: () => void;
  onArtifact: (path: string) => void;
}
const inputClass = "w-full min-w-0 rounded-input border border-border bg-surface px-2.5 py-2 text-sm text-text";
const buttonClass = "rounded-input border border-border px-3 py-2 text-xs text-text hover:bg-surface-2 disabled:opacity-40";
const MODES = ["guided", "collaborative", "delegated"] as const;
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

export function ResearchTaskPanel({ sessionId, visible, disabled, onStart, onContinue, onStop, onArtifact }: Props) {
  const { t } = useTranslation("session");
  const [task, setTask] = useState<ResearchTask | null>(null);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [expanded, setExpanded] = useState(false);
  const [objective, setObjective] = useState("");
  const [goal, setGoal] = useState<"thesis" | "publication">("thesis");
  const [mode, setMode] = useState<ResearchMode>("collaborative");
  const [inputs, setInputs] = useState("");
  const [deliverables, setDeliverables] = useState("report.md");
  const [confirmed, setConfirmed] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const callbacks = useRef({ onStop });
  callbacks.current = { onStop };

  useEffect(() => {
    setTask(null);
    setError(null);
    setLoading(Boolean(sessionId));
    if (!sessionId || !visible) return;
    let disposed = false;
    let inFlight = false;
    let ownsLease = false;
    let released = false;
    const release = () => {
      if (!ownsLease || released) return;
      released = true;
      callbacks.current.onStop();
      void researchRequest(sessionId, { action: "release", pageId: researchPageId }, true).catch(() => {});
    };
    const poll = async () => {
      if (inFlight || disposed || released) return;
      inFlight = true;
      try {
        const next = await researchRequest(sessionId);
        if (disposed) return;
        if (next) {
          ownsLease = true;
          await researchRequest(sessionId, { action: "heartbeat", pageId: researchPageId });
          if (disposed) { release(); return; }
        }
        setTask(next);
        setError(null);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
        if (!disposed) setLoading(false);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    window.addEventListener("pagehide", release);
    window.addEventListener("beforeunload", release);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("beforeunload", release);
      release();
    };
  }, [sessionId, visible, reload]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const act = async (payload: unknown) => {
    if (!sessionId) return;
    const next = await researchRequest(sessionId, payload);
    setTask(next);
  };
  const pending = task?.report?.decisions.filter((decision) => !task.decisions.some((d) => d.id === decision.id && d.question === decision.question)) ?? [];

  if (loading) return <p className="text-xs text-muted" role="status">{t("research.loading")}</p>;
  return (
    <section className="min-w-0 rounded-card border border-border bg-surface p-4 text-sm" aria-label={t("research.title")}>
      <div className="flex min-w-0 items-center gap-2">
        <FlaskConical size={16} className="shrink-0 text-accent" />
        <button className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left font-medium text-text" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          <span>{task ? t("research.title") : t("research.start")}</span>
          <ChevronDown size={14} className="shrink-0 text-muted" />
        </button>
        {task && <span className="shrink-0 text-xs text-muted">{t(`research.states.${task.status}`)}</span>}
      </div>
      {error && <div className="mt-3 text-xs text-warn" role="alert">{error}<button className="ml-2 underline" onClick={() => setReload((n) => n + 1)}>{t("research.retry")}</button></div>}
      {!task && expanded && (
        <form className="mt-4 space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed) return;
          void run(async () => {
            await onStart({ objective: objective.trim(), goal, mode, inputs: lines(inputs), deliverables: lines(deliverables), pageId: researchPageId });
            setReload((n) => n + 1);
          });
        }}>
          <p className="text-xs leading-relaxed text-muted">{t("research.intro")}</p>
          <label className="block space-y-1"><span>{t("research.objective")}</span><textarea className={inputClass} value={objective} onChange={(e) => setObjective(e.target.value)} required maxLength={4000} rows={2} /></label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1"><span>{t("research.goal")}</span><select aria-label={t("research.goal")} className={inputClass} value={goal} onChange={(e) => setGoal(e.target.value as typeof goal)}><option value="thesis">{t("research.goals.thesis")}</option><option value="publication">{t("research.goals.publication")}</option></select></label>
            <label className="block space-y-1"><span>{t("research.mode")}</span><select aria-label={t("research.mode")} className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as ResearchMode)}>{MODES.map((choice) => <option key={choice} value={choice}>{t(`research.modes.${choice}`)}</option>)}</select></label>
          </div>
          <p className="text-xs leading-relaxed text-muted">{t(`research.modeHints.${mode}`)}</p>
          <label className="block space-y-1"><span>{t("research.inputs")}</span><textarea className={inputClass} value={inputs} onChange={(e) => setInputs(e.target.value)} rows={2} /></label>
          <label className="block space-y-1"><span>{t("research.deliverables")}</span><textarea className={inputClass} value={deliverables} onChange={(e) => setDeliverables(e.target.value)} required rows={2} /></label>
          <p className="text-xs text-muted">{t("research.pathsHint")}</p>
          <label className="flex items-start gap-2 text-xs text-muted"><input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>{t("research.confirmScope")}</span></label>
          <button className={buttonClass} disabled={disabled || busy || !confirmed || !objective.trim() || !lines(deliverables).length}>{t("research.confirmStart")}</button>
        </form>
      )}
      {task && (
        <div className="mt-3 space-y-3">
          <p className="break-words text-text">{task.objective}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-2 text-muted"><span>{t("research.mode")}</span><select aria-label={t("research.mode")} className="min-w-0 rounded border border-border bg-surface p-1 text-text" value={task.mode} disabled={busy || disabled || task.executionActive} onChange={(event) => void run(() => act({ action: "mode", mode: event.target.value }))}>{MODES.map((choice) => <option key={choice} value={choice}>{t(`research.modes.${choice}`)}</option>)}</select></label>
            <span className="text-muted">{t("research.pageBound")}</span>
          </div>
          {task.report?.steps.length ? <ol className="space-y-1">{task.report.steps.map((step, n) => <li key={n} className="flex items-start gap-2 text-xs"><span className="shrink-0 text-muted">{n + 1}.</span><span className="min-w-0 break-words text-text">{step.title}</span><span className="ml-auto shrink-0 text-muted">{t(`research.steps.${step.status}`)}</span></li>)}</ol> : <p className="text-xs text-muted">{t("research.awaitingPlan")}</p>}
          {pending.map((decision) => <div key={decision.id} className="space-y-2 rounded-input bg-surface-2 p-3"><p className="break-words text-sm text-text">{decision.question}</p><label className="block space-y-1 text-xs"><span>{t("research.yourDecision")}</span><textarea className={inputClass} rows={2} value={answers[decision.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [decision.id]: e.target.value })} /></label><button className={buttonClass} disabled={busy || disabled || !answers[decision.id]?.trim()} onClick={() => void run(() => act({ action: "decide", id: decision.id, answer: answers[decision.id] }))}>{t("research.confirmDecision")}</button></div>)}
          {!!task.report?.artifacts.length && <div className="flex flex-wrap gap-2">{task.report.artifacts.map((artifact) => artifact.exists ? <button key={artifact.path} className={`${buttonClass} max-w-full break-all font-mono`} onClick={() => onArtifact(artifact.path)}>{artifact.path}</button> : <span key={artifact.path} className="break-all text-xs text-warn">{t("research.missingArtifact", { path: artifact.path })}</span>)}</div>}
          {!!task.report?.checks.length && <div className="space-y-1 text-xs"><p className="text-muted">{t("research.checkAttribution")}</p>{task.report.checks.map((check, n) => <div key={n} className="flex flex-wrap items-center gap-2"><span className="text-text">{check.title}</span><span className="text-muted">{t(`research.checks.${check.status}`)}</span>{check.evidence && (check.evidenceExists ? <button className="break-all font-mono text-accent underline" onClick={() => onArtifact(check.evidence!)}>{check.evidence}</button> : <span className="text-warn">{t("research.missingEvidence")}</span>)}</div>)}</div>}
          {task.report?.limitations && <p className="break-words text-xs text-warn">{task.report.limitations}</p>}
          {task.issue && <p className="break-words text-xs text-warn" role="status">{t(`research.issues.${task.issue}`)}</p>}
          {expanded && <div className="space-y-2 border-t border-faint pt-3 text-xs text-muted"><p>{t("research.requestedOutputs", { paths: task.deliverables.join(", ") })}</p><p>{t("research.inputFiles", { paths: task.inputs.join(", ") || t("research.noInputs") })}</p>{task.decisions.map((decision, n) => <p key={n} className="break-words"><span className="font-medium text-text">{decision.question}</span>{" "}{decision.answer}</p>)}</div>}
          <div className="flex flex-wrap gap-2">
            <button className={buttonClass} disabled={busy || disabled || pending.length > 0 || task.executionActive} onClick={() => void run(async () => { await onContinue(); })}>{t("research.continue")}</button>
            {task.executionActive && <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { await act({ action: "stop" }); onStop(); })}>{t("research.stop")}</button>}
          </div>
        </div>
      )}
    </section>
  );
}
