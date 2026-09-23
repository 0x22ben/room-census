// The one place where the site names message patterns. The data keeps its internal values
// (varied, mixed, repetitive, quiet); readers only ever see the words below. They describe
// messages, never the people or programs behind them.
export type Pattern = "varied" | "mixed" | "repetitive" | "quiet";

export const PATTERN: Record<Pattern, { short: string; sentence: string }> = {
  varied: { short: "Different", sentence: "Most messages are different" },
  mixed: { short: "Mixed", sentence: "Mixed message patterns" },
  repetitive: { short: "Repeated", sentence: "Most messages are repeated" },
  quiet: { short: "Low activity", sentence: "Not enough activity to describe" },
};

export const DISCLAIMER =
  "Message patterns describe how different or repeated recent public messages appear after normalization. They do not prove whether a message was written by a human or an automated agent.";

export const PATTERN_HELP =
  `How different or repeated a room's recent public messages are, once numbers are masked. Different: most messages differ. Mixed: some repeat. Repeated: most messages repeat. Low activity: too few messages to describe. ${DISCLAIMER}`;

// shown on My DID and written into every activity proof, word for word (approved by Ben)
export const DID_DISCLAIMER =
  "This page summarizes public Technocore activity. It does not determine ownership, reputation or eligibility for any reward.";
