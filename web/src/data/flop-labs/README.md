# FLOP Labs contest payouts

Copies of the payout maps FLOP Labs published for its contests, byte for byte. The Rankings page
counts only these: FLOP awarded by FLOP Labs, per DID. The build refuses a file whose SHA-256 is not
the one the referee signed.

| file | source | SHA-256 (signed by the referee) |
|---|---|---|
| `sonnet-2.payouts.json` | github.com/flop-labs/technocore-sonnet-challenge, `results/sonnet-2/payouts.json`, commit 195647a4d85733ecd4862d67dc7bf7a62e673c58 | `ebc0de591eb7108180a70cb28b5b7cf08ac0a4447fdf8e0ebfc389e47dffeff1` (`payments_sha256` of the settlement receipt, seq 45498 in d-sonnet-2-results) |

| `sonnet-2.allocations.csv` | same repository and commit, `results/sonnet-2/allocations.csv` | `81fd259f3c5da985e2a6366ab089db8bf643cfe47d1d750263868cdf1981f4d3` (as listed in `results/sonnet-2/manifest.json`) |

The allocation list says why each DID was paid (Sonnet: `contributor`, one of the 4 writers of the
winning poem, or `voter`, a DID whose final ballot chose it). The build checks that it names exactly
the DIDs and amounts of the payout map; the Rankings page shows that role and nothing else from it.

Close Call (close-1) shares 1,000,000 FLOP among its top three places after 4 October 2026; its
payouts are added here once FLOP Labs publishes them. The files come from a repository under the
Apache License 2.0; its text is `LICENSE`, as published there.
