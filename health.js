// Single source of truth for PoC health, shared by the React UI and the server.
//
// This used to exist twice — derivePocHealth() in se-tracker.jsx and pocHealth()
// in ingest.js — and the two drifted apart: they ordered the overdue and
// all-pass checks differently, so the dashboard called Citadel green while the
// LLM was told it was amber. Anything that answers "which PoCs are at risk"
// has to agree with what the user sees on screen, so there is now one function.
//
// Plain .js with no JSX and no Node built-ins, because both sides import it:
// the browser fetches it as an ES module (server.js serves it at /health.js)
// and Node imports it directly. Do not add JSX or `require` here.

const today = () => new Date().toISOString().slice(0, 10);

// Order matters. Overdue is checked *before* all-pass: a PoC where every
// criterion passed but the target date has blown is not healthy — if it really
// passed it should have closed, and if it can't close, something is wrong that
// the criteria aren't capturing. That's amber, not green.
export function derivePocHealth(opp) {
  const poc = opp?.poc;
  if (!poc || !poc.active || !poc.criteria?.length) return "none";

  const statuses = poc.criteria.map((c) => c.status);
  if (statuses.includes("fail") || statuses.includes("blocked")) return "red";
  if (poc.targetDate && poc.targetDate < today()) return "amber";
  // Everything else — all passed, or still working through pending criteria on
  // schedule — is green. A pending criterion is not by itself a problem.
  return "green";
}

// The definition of "at risk" used by the dashboard filter, the ingest feed and
// the chat prompt alike.
export const AT_RISK_HEALTH = ["amber", "red"];
export const isPocAtRisk = (opp) => AT_RISK_HEALTH.includes(derivePocHealth(opp));
