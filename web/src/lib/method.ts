// The classification rules in plain words, generated from the thresholds each census publishes
// (latest.json method.thresholds), so the text can never drift from the code that classified.
import { pct } from "./format";
import type { Latest } from "./data";

// not published in the data: mirrors MIN_WINDOW in room_census.py (checked by tests/test_web.py)
export const QUIET_MIN_MESSAGES = 30;

export function rules(latest: Latest) {
  const v = latest.method.thresholds.varied_min;
  const r = latest.method.thresholds.repetitive_if_any;
  return {
    varied: `at least ${pct(v.unique_tpl)} unique texts, at least ${pct(v.repeat_share)} of messages from senders who post more than once, no sender above ${pct(v.top_share)} of the messages, and at least ${v.eff_senders} effective senders`,
    repetitive: `under ${pct(r.unique_tpl)} unique texts, one sender writing ${pct(r.top_share)} or more of the messages, or under ${pct(r.repeat_share)} of messages from senders who post more than once`,
    quiet: `fewer than ${QUIET_MIN_MESSAGES} recent messages, or all of them posted at the same moment`,
    window: latest.method.window_msgs,
  };
}
