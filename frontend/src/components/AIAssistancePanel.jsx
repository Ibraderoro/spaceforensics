import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, AlertCircle } from "lucide-react";
import { getAssessmentLabel, getAssessmentColor } from "../utils/assessmentLabels";

/**
 * AIAssistancePanel
 *
 * Displays the validated AI analyst narrative and investigation assistance.
 * The AI layer is clearly labelled as "AI Synthesis" — never as evidence.
 *
 * Scientific rules:
 *   - No probability language.
 *   - No causal claims.
 *   - Hypothesis assessments displayed read-only from forensic analysis.
 *   - Environmental context never described as mechanism confirmation.
 *   - Source label always shown (heuristic vs llm).
 */

function CollapsibleSection({ title, children, defaultOpen = true, testId }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div data-testid={testId} className="flex flex-col">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full py-2 text-left"
        aria-expanded={open}
      >
        <span className="font-mono text-[10px] text-slate-400 uppercase tracking-wider">
          {title}
        </span>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        }
      </button>
      {open && children}
    </div>
  );
}

function StringList({ items, testId }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 mt-1" data-testid={testId}>
      {items.map((item, i) => (
        <li key={i} className="font-mono text-xs text-slate-300 leading-relaxed pl-2 border-l border-slate-700">
          {item}
        </li>
      ))}
    </ul>
  );
}

export default function AIAssistancePanel({ narrative, assistance, loading, error }) {
  if (loading) {
    return (
      <div data-testid="ai-assistance-loading" className="bg-slate-900 rounded-xl border border-slate-700 p-4">
        <p className="font-mono text-xs text-slate-500 italic">Loading AI analysis…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="ai-assistance-error" className="bg-slate-900 rounded-xl border border-red-900/60 p-4 flex gap-2">
        <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
        <p className="font-mono text-xs text-red-300">{error}</p>
      </div>
    );
  }

  if (!narrative && !assistance) {
    return (
      <div data-testid="ai-assistance-empty" className="bg-slate-900 rounded-xl border border-slate-700 p-4">
        <p className="font-mono text-xs text-slate-500 italic">AI analysis not available.</p>
      </div>
    );
  }

  return (
    <div
      data-testid="ai-assistance-panel"
      className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col overflow-hidden"
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-5 py-3 border-b border-slate-700 flex items-center gap-2">
        <Bot className="w-4 h-4 text-violet-400 shrink-0" />
        <h3 className="font-mono text-xs font-semibold text-slate-200 uppercase tracking-wider">
          AI Analyst
        </h3>
        {/* Source badge — always labelled so analysts know this is AI synthesis */}
        {(narrative?.source || assistance?.source) && (
          <span
            data-testid="ai-source-badge"
            className="font-mono text-[9px] px-1.5 py-0.5 rounded border bg-violet-950/40 text-violet-400 border-violet-800"
          >
            {narrative?.source === "llm" || assistance?.source === "llm" ? "LLM synthesis" : "Heuristic synthesis"}
          </span>
        )}
        <span className="font-mono text-[9px] text-slate-600 ml-auto">
          AI synthesis layer — not evidence
        </span>
      </div>

      <div className="p-4 flex flex-col gap-5 divide-y divide-slate-800">

        {/* ── Narrative section ──────────────────────────────────────────────── */}
        {narrative && (
          <div data-testid="ai-narrative-section" className="flex flex-col gap-4 pb-4">

            {narrative.executive_summary && (
              <CollapsibleSection title="Executive Summary" testId="narrative-executive-summary-section">
                <p
                  data-testid="narrative-executive-summary"
                  className="font-mono text-xs text-slate-300 leading-relaxed mt-1"
                >
                  {narrative.executive_summary}
                </p>
              </CollapsibleSection>
            )}

            {narrative.event_description && (
              <CollapsibleSection title="Event Description" testId="narrative-event-description-section">
                <p
                  data-testid="narrative-event-description"
                  className="font-mono text-xs text-slate-300 leading-relaxed mt-1"
                >
                  {narrative.event_description}
                </p>
              </CollapsibleSection>
            )}

            {Array.isArray(narrative.hypothesis_assessments) && narrative.hypothesis_assessments.length > 0 && (
              <CollapsibleSection title="Hypothesis Reasoning" testId="narrative-hypotheses-section">
                <div className="flex flex-col gap-3 mt-2" data-testid="narrative-hypothesis-list">
                  {narrative.hypothesis_assessments.map((ha) => (
                    <div
                      key={ha.hypothesis_id}
                      data-testid={`narrative-hypothesis-${ha.hypothesis_id}`}
                      className="flex flex-col gap-1.5 pl-3 border-l-2 border-slate-700"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-slate-200">
                          {ha.hypothesis_id}
                        </span>
                        {/* Assessment is read-only from forensic analysis — displayed only */}
                        <span
                          data-testid={`narrative-assessment-${ha.hypothesis_id}`}
                          className={`font-mono text-[9px] px-1.5 py-0.5 rounded border ${getAssessmentColor(ha.assessment)}`}
                        >
                          {getAssessmentLabel(ha.assessment)}
                        </span>
                      </div>
                      {ha.reasoning && (
                        <p
                          data-testid={`narrative-reasoning-${ha.hypothesis_id}`}
                          className="font-mono text-[11px] text-slate-400 leading-relaxed"
                        >
                          {ha.reasoning}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            )}

            {Array.isArray(narrative.strongest_observations) && narrative.strongest_observations.length > 0 && (
              <CollapsibleSection title="Strongest Observations" testId="narrative-observations-section">
                <StringList items={narrative.strongest_observations} testId="narrative-observations-list" />
              </CollapsibleSection>
            )}

            {Array.isArray(narrative.major_uncertainties) && narrative.major_uncertainties.length > 0 && (
              <CollapsibleSection title="Major Uncertainties" testId="narrative-uncertainties-section">
                <StringList items={narrative.major_uncertainties} testId="narrative-uncertainties-list" />
              </CollapsibleSection>
            )}

            {Array.isArray(narrative.missing_evidence) && narrative.missing_evidence.length > 0 && (
              <CollapsibleSection title="Missing Evidence" testId="narrative-missing-evidence-section">
                <StringList items={narrative.missing_evidence} testId="narrative-missing-evidence-list" />
              </CollapsibleSection>
            )}
          </div>
        )}

        {/* ── Assistance section ──────────────────────────────────────────────── */}
        {assistance && (
          <div data-testid="ai-assistance-content" className="flex flex-col gap-4 pt-4">
            <p className="font-mono text-[10px] text-slate-500 uppercase tracking-wider">
              Investigation Assistance
            </p>

            {assistance.findings_summary && (
              <CollapsibleSection title="Findings Summary" testId="assistance-findings-section">
                <p
                  data-testid="assistance-findings-summary"
                  className="font-mono text-xs text-slate-300 leading-relaxed mt-1"
                >
                  {assistance.findings_summary}
                </p>
              </CollapsibleSection>
            )}

            {Array.isArray(assistance.evidence_relationships) && assistance.evidence_relationships.length > 0 && (
              <CollapsibleSection title="Evidence Relationships" testId="assistance-evidence-relationships-section">
                <StringList items={assistance.evidence_relationships} testId="assistance-evidence-relationships-list" />
              </CollapsibleSection>
            )}

            {Array.isArray(assistance.limitations_explained) && assistance.limitations_explained.length > 0 && (
              <CollapsibleSection title="Limitations Explained" testId="assistance-limitations-section">
                <StringList items={assistance.limitations_explained} testId="assistance-limitations-list" />
              </CollapsibleSection>
            )}

            {Array.isArray(assistance.unanswered_questions) && assistance.unanswered_questions.length > 0 && (
              <CollapsibleSection title="Unanswered Questions" testId="assistance-questions-section">
                <StringList items={assistance.unanswered_questions} testId="assistance-questions-list" />
              </CollapsibleSection>
            )}

            {assistance.challenge_summary && (
              <CollapsibleSection title="Challenge Summary" testId="assistance-challenge-summary-section">
                <p
                  data-testid="assistance-challenge-summary"
                  className="font-mono text-xs text-slate-300 leading-relaxed mt-1"
                >
                  {assistance.challenge_summary}
                </p>
              </CollapsibleSection>
            )}

            {Array.isArray(assistance.additional_evidence_suggestions) && assistance.additional_evidence_suggestions.length > 0 && (
              <CollapsibleSection title="Additional Evidence Suggestions" testId="assistance-suggestions-section">
                <StringList items={assistance.additional_evidence_suggestions} testId="assistance-suggestions-list" />
              </CollapsibleSection>
            )}

            {Array.isArray(assistance.observation_inconsistencies) && assistance.observation_inconsistencies.length > 0 && (
              <CollapsibleSection title="Observation Inconsistencies" testId="assistance-inconsistencies-section">
                <StringList items={assistance.observation_inconsistencies} testId="assistance-inconsistencies-list" />
              </CollapsibleSection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
