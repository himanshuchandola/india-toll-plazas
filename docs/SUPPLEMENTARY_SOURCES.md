# Supplementary sources (Dataful): availability and licence review

Checked: 2026-10-26. Machine-readable version: [`data/supplementary/source-registry.json`](../data/supplementary/source-registry.json).

**Result: none of the seven sources is integrated.** No file could be downloaded, so nothing was parsed, validated or published. `data/latest.json` is unchanged and remains the only source of plaza records and tariffs.

## Why nothing was integrated

1. **Sign-in required.** On the two datasets Dataful lists as free (21597 NHAI plaza list, 18246 bank-wise NETC), the *Download CSV* button opens a Sign in / Sign up dialog (institution login, IP login, or email/Google account). The other five are listed as not free (subscription). The listing's structured metadata publishes no direct file URL (every `contentUrl` is the dataset page itself), and none was guessed.
2. **Terms.** [Dataful's terms](https://dataful.in/terms-and-conditions) prohibit reproducing or copying any portion of the service without written permission, spidering/crawling/scraping, and re-selling paywalled datasets. They say Factly does not own the raw official data and that the subscription pays for compilation work. Nothing there permits committing Dataful's files to a public GitHub repository, so redistribution is treated as **not permitted/unconfirmed**.
3. No account was created and no credentials were used.

## What the public listings say (labels, not verified from files)

| ID | Dataset | Source org | Rows | Period label | Free per listing |
|----|---------|-----------|------|--------------|------------------|
| 21597 | NHAI toll plaza master list | MoRTH / NHAI | 1,452 | 2026 | yes |
| 21607 | FASTag by plaza and vehicle category | MoRTH / IHMCL | 321,804 | 2022-23 to 2026-27 | no |
| 19664 | Monthly FASTag by plaza | MoRTH / IHMCL | 55,514 | 2021-22 to 2026-27 | no |
| 21608 | Annual-pass transactions by plaza | MoRTH / IHMCL | 31,681 | 2025-26 to 2026-27 | no |
| 23755 | MLFF tolling statistics | MoRTH / IHMCL | 508 | 2026 | no |
| 399 | NETC processing-time share | NPCI | 85,924 | 2021-22 to 2026-27 | no |
| 18246 | Bank-wise NETC FASTag volumes | NPCI | 9,051 | 2021-22 to 2026-27 | yes |

The listing's "Last Updated" label and its structured-data `dateModified` can disagree (for example dataset 18246), and neither is proof of when the underlying data changed. Once a file is obtained, the latest reporting period must be read from inside the file and stored separately from the retrieval timestamp.

## Relevance to this repo

- 21597 (plaza master) is the only one that could reconcile plaza codes, names and coordinates. It has 1,452 rows against 1,236 NHAI-sourced records in `data/latest.json` (as of 2026-10-26), which is why a reconciliation report would be useful once the file is legitimately in hand.
- 21607 / 19664 / 21608 / 23755 are **aggregate activity statistics**. They must stay separate from tariffs: a per-vehicle toll cannot be inferred from aggregate amounts collected, and they must never overwrite curated state-highway or expressway rates.
- 399 and 18246 are payment-system statistics with no per-plaza tariff relevance.

## Paths forward (need a decision from the repo owner)

- **Manual, local-only use:** someone with a Dataful account downloads the files themselves. They stay in a git-ignored local folder and are never committed. A reconciliation script can then produce a local report. This respects the terms but cannot be reproduced by CI or other contributors.
- **Ask Dataful for written permission** to redistribute derived aggregates, or for an API/bulk-access arrangement.
- **Use the original official sources** (NHAI, IHMCL, NPCI) where they publish the same data under open terms. Dataful names them on each listing, and this is the cleanest route for a public dataset.
