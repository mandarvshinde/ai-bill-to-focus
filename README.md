# ai-bill-to-focus

Turn AI provider bills into [FinOps FOCUS](https://focus.finops.org) 1.4 CSV, and check any CSV against the FOCUS 1.2, 1.3 or 1.4 rules. Everything runs on your machine; your files are never uploaded.

```sh
npx ai-bill-to-focus convert cost.csv usage.csv -o focus.csv --check
```

`cost.csv` and `usage.csv` stand for your own exports: use their real names or full paths, for example `"C:\Users\you\Downloads\claude_api_cost_2026_10_01_to_2026_10_30.csv"` (in quotes if the path has spaces).

The same converter and checker run in the browser at [cognocient.com/tools/focus-checker](https://www.cognocient.com/tools/focus-checker).

```
Anthropic -> FOCUS 1.4: 5 rows written to focus.csv
  provider total $0.82, FOCUS BilledCost total $0.82
  4 rows with quantities and unit prices (4 at Anthropic's public prices, 0 from its rounded cents), 1 with the provider's dollars only, 0 zero rows skipped

focus.csv (FOCUS 1.4): 5 rows, 40 columns, checked against FOCUS 1.4 (1.4.0.1)
0 errors, 0 warnings; 119 rules passed, 111 not applicable, 168 of 398 not checked here (need the full validator)
```

A few of the columns it writes, one row per day, model and token type:

| SkuMeter | ConsumedQuantity | ListUnitPrice ($/1M) | BilledCost |
|---|---|---|---|
| Input Tokens | 100000 | 3.00 | 0.30 |
| Cache Write Input Tokens (5 min) | 40000 | 3.75 | 0.15 |
| Cache Read Input Tokens | 200000 | 0.30 | 0.06 |
| Output Tokens | 20000 | 15.00 | 0.30 |
| Web Search | | | 0.01 |

## Supported exports

| Provider | Files | Status |
|---|---|---|
| Anthropic | Claude Console **Cost** export (platform.claude.com/cost), plus the **Usage** export (platform.claude.com/usage) for token quantities | Tested on real Console exports |
| OpenAI | Usage → Export → **Cost data** (group by line item, 1-day interval), plus the **Completions** activity export for token quantities | Built from OpenAI's documentation; not yet tested on a real export |
| Together AI | Cost analytics → **Download CSV** | Built from Together AI's documentation; not yet tested on a real export |

Bedrock, Vertex AI, Azure OpenAI and the Gemini API bill through their cloud, and those clouds already export FOCUS. Mistral and Groq offer no usage export for most accounts.

The provider and each file's role are detected from the header rows, so the order of the files doesn't matter. If a file isn't recognised, `ai-bill-to-focus detect <file>` says what it looks like.

## Reporting a problem without sharing your bill

```sh
npx ai-bill-to-focus report <your-cost-export.csv> <your-usage-export.csv>
```

Give the paths to your own provider exports, the same files you would pass to `convert`. For example, from the folder they were downloaded to:

```sh
npx ai-bill-to-focus report claude_api_cost_2026_10_01_to_2026_10_30.csv claude_api_tokens_2026_10_01_to_2026_10_30.csv
```

`report` converts in memory and prints a summary that is safe to paste into a public issue: each file's column names, row count and date range, the public model names, how each line item was read, the reconciliation gap as a percentage, and the FOCUS check counts. It contains no dollar amounts and no account, project, workspace or API key names; fine-tuned model names are cut to their base model, and file names are replaced by "file 1", "file 2". Read it before you paste it. The web tool has the same report behind **Copy a report to share**.

If you have an OpenAI or Together AI export, a report from it is the most useful thing you can [open an issue](https://github.com/mandarvshinde/ai-bill-to-focus/issues) with.

## When an export format changes

Columns are read by name, so a reordered file converts the same. Every converter also knows the full list of columns it expects:

- A column it doesn't read is named in a note, because it could hold tokens or dollars that the output is missing.
- A dollar or token cell that isn't a number (what a shifted or renamed column usually looks like) leaves that row out, says so, and makes `convert` exit `1`, so a script or CI job notices.

## What the output contains

- One FOCUS row per day, model and token type: uncached input, cache writes, cache reads and output each get their own `SkuId`, `SkuMeter` and unit price.
- `BilledCost` is always the provider's own dollar figure.
  - **Anthropic:** with both exports, a token row is priced as tokens × Anthropic's public price (cache writes 1.25× or 2× input). The row keeps that exact figure only when it rounds to the Cost export's cents; otherwise it keeps the provider's rounded dollars. `x_PriceSource` says which.
  - **OpenAI:** `input_tokens` already includes cached tokens, so uncached input is `input_tokens - input_cached_tokens`. Reasoning tokens are inside `output_tokens` the same way and are never added on top. Token counts fill `ConsumedQuantity` and derive the unit price, but never change a dollar amount. If a joined count implies a price more than 3× away from OpenAI's public price (adjusted for Batch, Flex or Priority), the count is dropped.
  - **OpenAI Batch and service tiers:** Batch, Flex and Priority bill the same model and token type at a different price. When the cost export gives a tier its own line item, it becomes its own FOCUS row (`SkuId` `.../input-batch`, `SkuMeter` "Input Tokens (Batch)") and gets only that tier's tokens, using the usage export's `batch` and `service_tier` columns. If the cost export doesn't split them, the row's unit price is a blend of the two rates and a note says so.
- Unit prices are written to 12 significant digits and dollar amounts to 10 decimal places, so there is no floating-point noise. The one exception is `ListCost`: it is the exact floating-point product of `ListUnitPrice` and `PricingQuantity` (for example `0.30000000000000004` for 3.0 × 0.1), because the FOCUS validator checks that product with exact equality.
- Provider details that FOCUS has no column for are kept as `x_` columns: workspace, API key, project, line item and so on. `Tags` is a single JSON column, as the spec requires.
- `BillingAccountId` and `BillingAccountName` come from the file when it has them; otherwise set them with `--account-id` and `--account-name`.

## Commands

```
ai-bill-to-focus convert <export.csv>... [-o focus.csv] [--account-id ID] [--account-name NAME]
                                         [--prices prices.json | --offline] [--check]
ai-bill-to-focus check <file.csv> [-v 1.4|1.3|1.2] [-c ai|all|none|LIST] [--json] [--strict]
ai-bill-to-focus check --list-criteria [-v 1.4]
ai-bill-to-focus detect <file.csv>...
ai-bill-to-focus report <export.csv>... [--prices prices.json | --offline]
```

`check` runs the rule models from the FinOps Foundation's [focus-validator](https://github.com/finopsfoundation/focus-spec-validator) (column presence, types, formats, allowed values and cross-column rules), ported to JavaScript. Rules that need the full validator, such as dynamic rules, are counted and reported, not silently passed. To certify a file, run the official validator as well.

Applicability criteria decide which conditional columns are required. The default, `ai`, declares what a direct AI API bill supports: account naming, tagging, usage measurement, unit pricing and a public price list. Use `--list-criteria` to see the rest.

Exit codes are `0` for OK, `1` for FOCUS errors, a failed conversion or unreadable rows, and `2` for bad usage. That makes `check` usable as a CI gate.

## Network use

`convert` for Anthropic and OpenAI downloads the public model price list from `https://api.cognocient.com/api/estimate/models`. The request carries nothing about your files. Use `--offline` to skip it (Anthropic token rows then get unit prices worked out from Anthropic's rounded cents instead of its public prices), or `--prices file.json` to provide your own list in the same format. `check`, `detect` and the Together AI converter make no network requests.

## Development

```sh
npm install
npm test        # builds, then runs the CLI on the synthetic exports in test/fixtures
```

`src/lib` holds the checker and converters. They are developed alongside the web tool and synced into this repo, so the CLI and the web page give the same answers. The FOCUS rule JSON in `src/lib/rules-*.json` is generated from the focus-spec-validator rule models. Issues and pull requests are welcome; for a new provider, the export's header row and a few anonymised rows are the most useful thing to include.

## License

MIT. The bundled FOCUS rule data comes from the FinOps Foundation's focus-spec-validator (MIT); see THIRD_PARTY_NOTICES.md. FOCUS is a trademark of the FinOps Foundation; this project is not affiliated with or endorsed by it.
