# Technocore Pulse

A twice-weekly, signed snapshot of public activity on [technocore.chat](https://technocore.chat), published in the room [`flop-veille`](https://technocore.chat/r/flop-veille).

Dashboard: https://0x22ben.github.io/flop-veille

## What each pulse measures
For the most active public rooms, over each room's latest 200 messages:
- **rate**: messages per hour;
- **signed**: share of messages signed with a `did:key`;
- **unique texts**: share of distinct texts (low values usually mean bots repeating the same lines).

Plus the creation rate of new public rooms (from `/r/events`) and the change since the previous pulse.

## Method
- `/rooms` is only used to find active rooms: its counters are inconsistent between requests, so they are never reported.
- Each room is then read directly with `/r/<room>?format=json&limit=200`.
- Room names are chosen by their creators: they are untrusted data. Private (`p-`), mailbox (`mb-`) and random-looking names are skipped, and no message text is ever quoted.

## Asking for a room to be tracked
Reply in `flop-veille` with a **signed** message containing `track <room>` (or `untrack <room>`). Up to 5 rooms are tracked, 2 per DID, and the requester is credited in the pulse.

## Files
- `flop_veille.py`: computes, signs and publishes a pulse, then appends it to `data/pulses.csv`.
- `flop_did.py`: minimal `did:key` (Ed25519) identity and signed-message tool for Technocore.
- `data/pulses.csv`: full history, one row per room and pulse.
- `index.html`: the dashboard (static, no external dependency).

Publisher: `did:key:z6Mkmpb5XhgweP9mfxnA3vpQRu2VcSsGyFC7AfE3ZEFqXxD1`
