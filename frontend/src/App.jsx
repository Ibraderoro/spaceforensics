import { useState, useEffect } from "react";
import { Loader2, FlaskConical, FileText } from "lucide-react";
import Header from "./components/Header";
import EventTimeline from "./components/EventTimeline";
import HypothesisMatrix from "./components/HypothesisMatrix";
import ForensicInvestigationView from "./components/ForensicInvestigationView";
import RedTeamPanel from "./components/RedTeamPanel";
import ReportModal from "./components/ReportModal";
import InvestigationTimeline from "./components/InvestigationTimeline";
import EvidenceGraphExplorer from "./components/EvidenceGraphExplorer";
import InvestigationWorkspace from "./components/InvestigationWorkspace";
import { fetchCaseMeta, fetchTimeline, fetchEvidenceGraph, fetchForensicAnalysis, postInvestigate, fetchCaseList } from "./api";

export default function App() {
  const [caseMeta,         setCaseMeta]         = useState(null);
  const [timelineData,     setTimelineData]     = useState([]);
  const [hypotheses,       setHypotheses]       = useState(null);
  const [challengeData,    setChallengeData]    = useState(null);
  const [showReport,       setShowReport]       = useState(false);
  const [loading,          setLoading]          = useState(true);
  const [investigating,    setInvestigating]    = useState(false);
  const [initError,        setInitError]        = useState(null);
  const [forensicReport,   setForensicReport]   = useState(null);
  const [evidenceGraph,    setEvidenceGraph]     = useState(null);
  const [forensicLoading,  setForensicLoading]  = useState(true);
  const [forensicError,    setForensicError]    = useState(null);
  const [selectedCaseId,   setSelectedCaseId]   = useState("galaxy-15");
  const [caseList,         setCaseList]         = useState([]);

  // Load case metadata + timeline on mount (critical path); re-runs when selectedCaseId changes
  useEffect(() => {
    setLoading(true);
    setInitError(null);
    Promise.all([fetchCaseMeta(selectedCaseId), fetchTimeline(selectedCaseId), fetchCaseList()])
      .then(([meta, timeline, cases]) => {
        setCaseMeta(meta);
        setTimelineData(timeline);
        setCaseList(cases);
      })
      .catch((err) => setInitError(err.message))
      .finally(() => setLoading(false));
  }, [selectedCaseId]);

  // Load forensic analysis + evidence graph in parallel (non-blocking); re-runs on case change
  useEffect(() => {
    setForensicLoading(true);
    setForensicError(null);
    setForensicReport(null);
    setEvidenceGraph(null);
    Promise.allSettled([fetchForensicAnalysis(selectedCaseId), fetchEvidenceGraph(selectedCaseId)])
      .then(([forensicResult, graphResult]) => {
        if (forensicResult.status === "fulfilled") setForensicReport(forensicResult.value);
        if (graphResult.status === "fulfilled")    setEvidenceGraph(graphResult.value);
        // Surface an error only when both fail — a partial result is still useful.
        if (forensicResult.status === "rejected" && graphResult.status === "rejected") {
          setForensicError("Forensic analysis unavailable — could not reach the API. Verify the backend is running.");
        }
      })
      .finally(() => setForensicLoading(false));
  }, [selectedCaseId]);

  async function handleInvestigate() {
    setInvestigating(true);
    try {
      const result = await postInvestigate(selectedCaseId);
      setHypotheses(result.hypotheses);
    } catch (err) {
      console.error("Investigate error:", err);
    } finally {
      setInvestigating(false);
    }
  }

  function handleChallengeComplete(data) {
    setChallengeData(data);
    // Merge updated confidence scores from Pass 2 back into hypothesis list
    if (data.updated_hypotheses?.length) {
      setHypotheses(data.updated_hypotheses);
    }
  }

  // ── Full-page loader ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-10 h-10 text-cyan-400 animate-spin" />
        <p className="font-mono text-sm text-slate-400">Connecting to SPACEFORENSICS API…</p>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-3 px-6">
        <p className="font-mono text-red-400 text-sm">Connection error: {initError}</p>
        <p className="font-mono text-slate-500 text-xs">Ensure the backend is running on http://localhost:5001</p>
      </div>
    );
  }

  // ── Main layout ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header caseMeta={caseMeta} />

      {/* Case selector — only visible when more than one case is available */}
      {caseList.length > 1 && (
        <div className="flex justify-center py-2 bg-slate-900 border-b border-slate-800">
          <select
            value={selectedCaseId}
            onChange={(e) => setSelectedCaseId(e.target.value)}
            className="font-mono text-xs bg-slate-800 text-slate-300 border border-slate-600 rounded px-3 py-1"
          >
            {caseList.map((c) => (
              <option key={c.case_id} value={c.case_id}>{c.title || c.case_id}</option>
            ))}
          </select>
        </div>
      )}

      <main className="max-w-screen-2xl mx-auto px-4 md:px-6 py-6">
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

          {/* ── Left column (timeline + hypothesis matrix) ── */}
          <div className="xl:col-span-2 flex flex-col gap-6">

            {/* Timeline chart */}
            <EventTimeline
              timelineData={timelineData}
              anchorTimestamp={caseMeta?.anchor_event?.timestamp}
            />

            {/* Investigation Timeline — full record list with provenance */}
            <InvestigationTimeline
              timelineData={timelineData}
              anchorTimestamp={caseMeta?.anchor_event?.timestamp}
              reportHypotheses={forensicReport?.hypotheses ?? []}
              caseId={selectedCaseId}
            />

            {/* Investigate button */}
            <div className="flex items-center gap-4">
              <button
                onClick={handleInvestigate}
                disabled={investigating}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-mono text-sm font-semibold
                           bg-cyan-700 hover:bg-cyan-600 active:bg-cyan-800
                           disabled:opacity-60 disabled:cursor-not-allowed
                           transition-colors border border-cyan-600 shadow-lg shadow-cyan-900/30"
              >
                {investigating
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <FlaskConical className="w-4 h-4" />
                }
                {investigating ? "Running Analysis…" : "Run Pass 1 — Investigate"}
              </button>

              {hypotheses && (
                <span className="text-xs font-mono text-slate-500">
                  {hypotheses.length} hypotheses scored
                  {challengeData && " · Pass 2 applied"}
                </span>
              )}
            </div>

            {/* Hypothesis matrix */}
            <HypothesisMatrix
              hypotheses={hypotheses}
              timelineData={timelineData}
              caseMeta={caseMeta}
            />

            {/* Forensic Investigation View */}
            {forensicLoading ? (
              <div
                data-testid="forensic-loading"
                className="bg-slate-900 rounded-xl p-6 border border-slate-700 flex items-center gap-3"
              >
                <Loader2 className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />
                <p className="font-mono text-xs text-slate-500">Loading forensic analysis…</p>
              </div>
            ) : forensicError ? (
              <div
                data-testid="forensic-error"
                className="bg-slate-900 rounded-xl p-6 border border-red-800/60 flex flex-col gap-2"
              >
                <p className="font-mono text-sm font-semibold text-red-400">Forensic analysis unavailable</p>
                <p className="font-mono text-xs text-slate-400">{forensicError}</p>
              </div>
            ) : (
              <>
                <ForensicInvestigationView
                  report={forensicReport}
                  timelineData={timelineData}
                  evidenceGraph={evidenceGraph}
                />
                <EvidenceGraphExplorer
                  evidenceGraph={evidenceGraph}
                  forensicReport={forensicReport}
                />
              </>
            )}

            {/* Investigation Workspace — Phase 7 analyst layer */}
            <InvestigationWorkspace caseId={selectedCaseId} />
          </div>

          {/* ── Right column (red-team + export) ── */}
          <div className="xl:col-span-1 flex flex-col gap-6">
            <RedTeamPanel
              onChallengeComplete={handleChallengeComplete}
              challengeData={challengeData}
              timelineData={timelineData}
              caseMeta={caseMeta}
            />

            {/* Export Report button */}
            <button
              onClick={() => setShowReport(true)}
              className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg font-mono text-sm
                         bg-slate-800 hover:bg-slate-700 border border-slate-600
                         transition-colors text-slate-300 hover:text-slate-100"
            >
              <FileText className="w-4 h-4" />
              Export Forensic Report
            </button>

            {/* Case metadata card */}
            {caseMeta && (
              <div className="bg-slate-900 rounded-xl p-4 border border-slate-700">
                <h3 className="font-mono text-xs text-slate-400 uppercase tracking-wider mb-3">Case Metadata</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs">
                  <dt className="text-slate-500">Case ID</dt>
                  <dd className="text-slate-300">{caseMeta.case_id}</dd>
                  <dt className="text-slate-500">Anchor Event</dt>
                  <dd className="text-amber-400">{caseMeta.anchor_event?.timestamp ?? "—"}</dd>
                  <dt className="text-slate-500">Records</dt>
                  <dd className="text-slate-300">{timelineData.length}</dd>
                  <dt className="text-slate-500">NORAD ID</dt>
                  <dd className="text-slate-300">{caseMeta.target_asset?.norad_id}</dd>
                  <dt className="text-slate-500">Bus</dt>
                  <dd className="text-slate-300">{caseMeta.target_asset?.spacecraft_bus}</dd>
                </dl>
                {caseMeta.description && (
                  <p className="mt-3 text-slate-500 text-xs leading-relaxed border-t border-slate-800 pt-3">
                    {caseMeta.description}
                  </p>
                )}
              </div>
            )}
          </div>

        </div>
      </main>

      <ReportModal
        isOpen={showReport}
        onClose={() => setShowReport(false)}
        caseMeta={caseMeta}
        hypotheses={hypotheses}
        challengeData={challengeData}
      />
    </div>
  );
}
