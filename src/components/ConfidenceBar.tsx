"use client";

/**
 * The single most important widget in a review UI: it has to make "trust this"
 * and "check this" separable at a glance, without the reviewer reading a number.
 */
export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  const colour =
    pct >= 0.85 ? "var(--ok)" : pct >= 0.6 ? "var(--warn)" : "var(--err)";

  return (
    <div className="meter" title={`${(pct * 100).toFixed(1)}% confidence`}>
      <div className="track">
        <div className="fill" style={{ width: `${pct * 100}%`, background: colour }} />
      </div>
      <span className="num">{(pct * 100).toFixed(0)}%</span>
    </div>
  );
}
