import { useMemo } from "react";
import type { StoreApp } from "../../domain/catalog";
import { assessAppExecutionOffline } from "../../services/execution/assessor";
import { METHOD_LABEL, unavailabilityNote } from "../../domain/execution";

interface ExecutionMethodsProps {
  app: StoreApp;
  /** Show detailed reasons under each chip. Default true on the app detail page. */
  detailed?: boolean;
}

/**
 * Renders the unified execution-method selection for one application:
 * Android emulator, native Windows, phone-powered desktop.
 * Each chip shows whether the method is available on this host and why.
 */
export default function ExecutionMethods({
  app,
  detailed = false,
}: ExecutionMethodsProps) {
  const decision = useMemo(() => assessAppExecutionOffline(app), [app]);

  return (
    <section className="execution-methods">
      <div className="execution-head">
        <strong>Run this app on</strong>
        <span className="execution-summary">{decision.summary}</span>
      </div>
      <div className="execution-chip-list" role="group" aria-label="Execution methods">
        {decision.assessments.map((a) => {
          const note = unavailabilityNote(a);
          const available = a.available;
          return (
            <article
              key={a.method}
              className={`execution-chip ${available ? "available" : "unavailable"}`}
            >
              <div className="execution-chip-head">
                <span className="execution-chip-dot" aria-hidden="true">{available ? "●" : "○"}</span>
                <span className="execution-chip-name">{METHOD_LABEL[a.method]}</span>
                {available && <span className="execution-chip-badge">AVAILABLE</span>}
              </div>
              {detailed && (
                <p className="execution-chip-reason">
                  {available ? a.reason : note || a.reason}
                </p>
              )}
              {!detailed && !available && (
                <span className="execution-chip-note">{note}</span>
              )}
            </article>
          );
        })}
      </div>
      {!detailed && decision.recommended && (
        <p className="execution-recommend">
          Recommended: <strong>{METHOD_LABEL[decision.recommended]}</strong>{" "}
          {decision.alternatives.length
            ? `· Also: ${decision.alternatives.map((m) => METHOD_LABEL[m]).join(", ")}`
            : "."}
        </p>
      )}
    </section>
  );
}
