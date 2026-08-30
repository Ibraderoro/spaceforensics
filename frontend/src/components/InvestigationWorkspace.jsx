import { useState, useEffect, useCallback } from "react";
import { Loader2, FlaskConical, AlertCircle, X, PlusCircle } from "lucide-react";
import {
  createInvestigation,
  fetchInvestigations,
  fetchInvestigationSummary,
  fetchInvestigationAssistance,
  fetchInvestigationHistory,
  fetchObservations,
  fetchChallenges,
  patchInvestigationStatus,
} from "../api";
import ForensicConclusionPanel    from "./ForensicConclusionPanel";
import HypothesisAssessmentPanel  from "./HypothesisAssessmentPanel";
import LimitationsPanel            from "./LimitationsPanel";
import AIAssistancePanel           from "./AIAssistancePanel";
import ObservationsPanel           from "./ObservationsPanel";
import ChallengesPanel             from "./ChallengesPanel";
import InvestigationHistoryPanel   from "./InvestigationHistoryPanel";

/**
 * InvestigationWorkspace
 *
 * Root component for the Phase 7 investigation workspace.
 *
 * Rules enforced:
 *   - Forensic analysis is read-only; no analyst action can mutate it.
 *   - AI narrative is labelled "AI synthesis layer — not evidence".
 *   - Environmental context is rendered by HypothesisAssessmentPanel with
 *     explicit visual separation and disclaimer.
 *   - No probability language.
 *   - Causal attribution shows NOT ESTABLISHED when false.
 *   - Analyst observations and challenges are strictly isolated from the
 *     forensic conclusion.
 */

const STATUS_ALLOWED_TRANSITIONS = {
  open:      ["suspended", "closed"],
  suspended: ["open", "closed"],
  "re-opened": ["suspended", "closed"],
};

const STATUS_STYLES = {
  open:         "bg-green-900/40 text-green-300 border-green-800",
  suspended:    "bg-amber-900/40 text-amber-300 border-amber-800",
  "re-opened":  "bg-cyan-900/40 text-cyan-300 border-cyan-800",
  closed:       "bg-slate-700 text-slate-400 border-slate-600",
};

const TABS = [
  { id: "forensic",      label: "Forensic Analysis" },
  { id: "hypotheses",    label: "Hypotheses" },
  { id: "ai",            label: "AI Analyst" },
  { id: "observations",  label: "Observations" },
  { id: "challenges",    label: "Challenges" },
  { id: "history",       label: "History" },
];

// ── New investigation form ─────────────────────────────────────────────────────
function NewInvestigationForm({ caseId, onCreate, onCancel }) {
  const [title,      setTitle]      = useState("");
  const [openedBy,   setOpenedBy]   = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError,  setFormError]  = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) { setFormError("Title is required."); return; }
    setFormError(null);
    setSubmitting(true);
    try {
      const inv = await createInvestigation(caseId, {
        title:       title.trim(),
        opened_by:   openedBy.trim() || undefined,
        description: description.trim() || undefined,
      });
      onCreate(inv);
    } catch (err) {
      setFormError(err.message || "Failed to create investigation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      data-testid="new-investigation-form"
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 bg-slate-800/40 rounded-xl border border-slate-700 p-4"
    >
      <p className="font-mono text-xs text-slate-300 font-semibold uppercase tracking-wider">
        New Investigation
      </p>

      <input
        data-testid="new-investigation-title"
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Investigation title"
        className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-3 py-1.5
                   text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
      />
      <input
        data-testid="new-investigation-opened-by"
        type="text"
        value={openedBy}
        onChange={(e) => setOpenedBy(e.target.value)}
        placeholder="Opened by (optional)"
        className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-3 py-1.5
                   text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
      />
      <textarea
        data-testid="new-investigation-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        className="font-mono text-xs bg-slate-800 border border-slate-600 rounded px-3 py-2
                   text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 resize-none"
      />

      {formError && (
        <div data-testid="new-investigation-form-error" className="flex items-center gap-1.5 text-red-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="font-mono text-xs">{formError}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button
          data-testid="new-investigation-submit"
          type="submit"
          disabled={submitting}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs
                     bg-cyan-800 hover:bg-cyan-700 border border-cyan-700 text-cyan-100
                     disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5" />}
          {submitting ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded font-mono text-xs bg-slate-800 hover:bg-slate-700
                     border border-slate-700 text-slate-400 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Main workspace ─────────────────────────────────────────────────────────────
export default function InvestigationWorkspace({ caseId }) {
  const [investigations,    setInvestigations]    = useState([]);
  const [selectedId,        setSelectedId]        = useState(null);
  const [showNewForm,       setShowNewForm]        = useState(false);
  const [listLoading,       setListLoading]        = useState(true);
  const [listError,         setListError]          = useState(null);

  // Per-investigation data
  const [summary,           setSummary]           = useState(null);
  const [summaryLoading,    setSummaryLoading]    = useState(false);
  const [summaryError,      setSummaryError]      = useState(null);

  const [assistance,        setAssistance]        = useState(null);
  const [assistanceLoading, setAssistanceLoading] = useState(false);
  const [assistanceError,   setAssistanceError]   = useState(null);

  const [history,           setHistory]           = useState(null);
  const [historyLoading,    setHistoryLoading]    = useState(false);
  const [historyError,      setHistoryError]      = useState(null);

  const [observations,      setObservations]      = useState([]);
  const [challenges,        setChallenges]        = useState([]);

  const [activeTab,         setActiveTab]         = useState("forensic");
  const [statusBusy,        setStatusBusy]        = useState(false);

  // ── Load investigation list ────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const list = await fetchInvestigations(caseId);
      setInvestigations(list);
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0].investigation_id);
      }
    } catch (err) {
      setListError(err.message || "Failed to load investigations.");
    } finally {
      setListLoading(false);
    }
  }, [caseId, selectedId]);

  useEffect(() => { loadList(); }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load per-investigation data ────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) return;

    setSummary(null); setSummaryLoading(true); setSummaryError(null);
    fetchInvestigationSummary(caseId, selectedId)
      .then(setSummary)
      .catch((err) => setSummaryError(err.message || "Failed to load summary."))
      .finally(() => setSummaryLoading(false));

    setAssistance(null); setAssistanceLoading(true); setAssistanceError(null);
    fetchInvestigationAssistance(caseId, selectedId)
      .then(setAssistance)
      .catch((err) => setAssistanceError(err.message || "Failed to load AI assistance."))
      .finally(() => setAssistanceLoading(false));

    setHistory(null); setHistoryLoading(true); setHistoryError(null);
    fetchInvestigationHistory(caseId, selectedId)
      .then(setHistory)
      .catch((err) => setHistoryError(err.message || "Failed to load history."))
      .finally(() => setHistoryLoading(false));

    fetchObservations(caseId, selectedId).then(setObservations).catch(() => {});
    fetchChallenges(caseId, selectedId).then((data) => setChallenges(data.challenges ?? data)).catch(() => {});
  }, [caseId, selectedId]);

  // ── Derived: current investigation record ──────────────────────────────────
  const currentInv = investigations.find((i) => i.investigation_id === selectedId);
  const allowedTransitions = STATUS_ALLOWED_TRANSITIONS[currentInv?.status] ?? [];

  // ── Status transition ──────────────────────────────────────────────────────
  async function handleStatusTransition(status) {
    setStatusBusy(true);
    try {
      const updated = await patchInvestigationStatus(caseId, selectedId, { status, actor: "analyst" });
      setInvestigations((prev) =>
        prev.map((i) => (i.investigation_id === selectedId ? { ...i, status: updated.status } : i))
      );
    } catch (_) { /* non-fatal */ }
    finally { setStatusBusy(false); }
  }

  // ── Create new investigation ────────────────────────────────────────────────
  function handleCreated(inv) {
    setInvestigations((prev) => [inv, ...prev]);
    setSelectedId(inv.investigation_id);
    setShowNewForm(false);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (listLoading) {
    return (
      <div data-testid="workspace-loading" className="bg-slate-900 rounded-xl border border-slate-700 p-6 flex items-center gap-3">
        <Loader2 className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />
        <p className="font-mono text-xs text-slate-500">Loading investigations…</p>
      </div>
    );
  }

  if (listError) {
    return (
      <div data-testid="workspace-error" className="bg-slate-900 rounded-xl border border-red-900/60 p-6 flex gap-2">
        <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
        <p className="font-mono text-xs text-red-300">{listError}</p>
      </div>
    );
  }

  return (
    <div data-testid="investigation-workspace" className="flex flex-col gap-4">

      {/* ── Workspace header ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-cyan-400 shrink-0" />
          <h2 className="font-mono text-sm font-semibold text-slate-200 uppercase tracking-wider">
            Investigation Workspace
          </h2>
          <span className="font-mono text-[10px] text-slate-500">{investigations.length} investigation(s)</span>
        </div>
        <button
          data-testid="new-investigation-btn"
          onClick={() => setShowNewForm((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-xs
                     bg-cyan-900/40 hover:bg-cyan-800/60 border border-cyan-800 text-cyan-300
                     transition-colors"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          New Investigation
        </button>
      </div>

      {/* ── New investigation form ───────────────────────────────────────────── */}
      {showNewForm && (
        <NewInvestigationForm
          caseId={caseId}
          onCreate={handleCreated}
          onCancel={() => setShowNewForm(false)}
        />
      )}

      {/* ── Investigation selector tabs (if > 1) ────────────────────────────── */}
      {investigations.length === 0 ? (
        <div
          data-testid="workspace-empty"
          className="bg-slate-900 rounded-xl border border-slate-700 p-6"
        >
          <p className="font-mono text-xs text-slate-500 italic">
            No investigations for this case. Create one above.
          </p>
        </div>
      ) : (
        <>
          {/* Investigation picker */}
          {investigations.length > 1 && (
            <div
              data-testid="investigation-selector"
              className="flex gap-2 flex-wrap"
            >
              {investigations.map((inv) => (
                <button
                  key={inv.investigation_id}
                  data-testid={`investigation-selector-${inv.investigation_id}`}
                  onClick={() => setSelectedId(inv.investigation_id)}
                  className={`font-mono text-[10px] px-2.5 py-1 rounded border transition-colors
                    ${inv.investigation_id === selectedId
                      ? "bg-cyan-900/50 text-cyan-200 border-cyan-700"
                      : "bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700"
                    }`}
                >
                  {inv.title ?? inv.investigation_id}
                </button>
              ))}
            </div>
          )}

          {/* ── Investigation identity bar ─────────────────────────────────────── */}
          {currentInv && (
            <div
              data-testid="investigation-identity"
              className="bg-slate-900 rounded-xl border border-slate-700 px-5 py-3 flex items-center gap-4 flex-wrap"
            >
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs font-semibold text-slate-200 truncate">
                  {currentInv.title ?? currentInv.investigation_id}
                </p>
                <p className="font-mono text-[10px] text-slate-500">
                  {currentInv.investigation_id}
                  {currentInv.opened_by && <> · opened by {currentInv.opened_by}</>}
                  {currentInv.opened_at && <> · {currentInv.opened_at}</>}
                </p>
              </div>
              {/* Status badge */}
              <span
                data-testid="investigation-status-badge"
                className={`font-mono text-[9px] px-2 py-0.5 rounded border ${STATUS_STYLES[currentInv.status] ?? STATUS_STYLES.closed}`}
              >
                {currentInv.status}
              </span>
              {/* Lifecycle transitions */}
              {allowedTransitions.length > 0 && (
                <div className="flex gap-1.5" data-testid="investigation-transitions">
                  {allowedTransitions.map((nextStatus) => (
                    <button
                      key={nextStatus}
                      data-testid={`status-transition-${nextStatus}`}
                      disabled={statusBusy}
                      onClick={() => handleStatusTransition(nextStatus)}
                      className={`font-mono text-[9px] px-2 py-1 rounded border transition-colors
                        ${STATUS_STYLES[nextStatus] ?? "bg-slate-700 text-slate-400 border-slate-600"}
                        disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-80`}
                    >
                      {statusBusy
                        ? <Loader2 className="w-3 h-3 animate-spin inline" />
                        : `→ ${nextStatus}`
                      }
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Tab navigation ─────────────────────────────────────────────────── */}
          <div
            data-testid="workspace-tabs"
            className="flex gap-1 border-b border-slate-800 pb-0 overflow-x-auto"
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                data-testid={`tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`font-mono text-[10px] px-3 py-2 border-b-2 whitespace-nowrap transition-colors
                  ${activeTab === tab.id
                    ? "border-cyan-500 text-cyan-300"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                  }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Tab content ────────────────────────────────────────────────────── */}
          <div data-testid="workspace-tab-content">

            {/* Forensic Analysis tab */}
            {activeTab === "forensic" && (
              <div data-testid="tab-content-forensic" className="flex flex-col gap-4">
                {summaryLoading ? (
                  <div data-testid="summary-loading" className="bg-slate-900 rounded-xl border border-slate-700 p-6 flex items-center gap-3">
                    <Loader2 className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />
                    <p className="font-mono text-xs text-slate-500">Loading forensic summary…</p>
                  </div>
                ) : summaryError ? (
                  <div data-testid="summary-error" className="bg-slate-900 rounded-xl border border-red-900/60 p-4 flex gap-2">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <p className="font-mono text-xs text-red-300">{summaryError}</p>
                  </div>
                ) : (
                  <>
                    <ForensicConclusionPanel
                      forensicConclusion={summary?.forensic_conclusion}
                    />
                    <LimitationsPanel
                      limitations={summary?.limitations}
                    />
                  </>
                )}
              </div>
            )}

            {/* Hypotheses tab */}
            {activeTab === "hypotheses" && (
              <div data-testid="tab-content-hypotheses">
                {summaryLoading ? (
                  <div data-testid="hypotheses-loading" className="bg-slate-900 rounded-xl border border-slate-700 p-6 flex items-center gap-3">
                    <Loader2 className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />
                    <p className="font-mono text-xs text-slate-500">Loading hypotheses…</p>
                  </div>
                ) : (
                  <HypothesisAssessmentPanel hypotheses={summary?.hypotheses} />
                )}
              </div>
            )}

            {/* AI Analyst tab */}
            {activeTab === "ai" && (
              <div data-testid="tab-content-ai">
                <AIAssistancePanel
                  narrative={summary?.ai_narrative}
                  assistance={assistance}
                  loading={assistanceLoading}
                  error={assistanceError}
                />
              </div>
            )}

            {/* Observations tab */}
            {activeTab === "observations" && (
              <div data-testid="tab-content-observations">
                <ObservationsPanel
                  caseId={caseId}
                  investigationId={selectedId}
                  observations={observations}
                  onObservationAdded={(obs) => setObservations((prev) => [...prev, obs])}
                />
              </div>
            )}

            {/* Challenges tab */}
            {activeTab === "challenges" && (
              <div data-testid="tab-content-challenges">
                <ChallengesPanel
                  caseId={caseId}
                  investigationId={selectedId}
                  challenges={challenges}
                  onChallengeCreated={(c) => setChallenges((prev) => [...prev, c])}
                  onChallengeTransitioned={(updated) =>
                    setChallenges((prev) =>
                      prev.map((c) => (c.challenge_id === updated.challenge_id ? updated : c))
                    )
                  }
                />
              </div>
            )}

            {/* History tab */}
            {activeTab === "history" && (
              <div data-testid="tab-content-history">
                <InvestigationHistoryPanel
                  history={history}
                  loading={historyLoading}
                  error={historyError}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
