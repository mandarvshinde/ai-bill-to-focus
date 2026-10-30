# ai-bill-to-focus

Turn AI provider bills into [FinOps FOCUS](https://focus.finops.org) 1.4 CSV, and check any CSV against the FOCUS 1.2, 1.3 or 1.4 rules. Everything runs on your machine; your files are never uploaded.

```sh
npx ai-bill-to-focus convert cost.csv usage.csv -o focus.csv --check
```

The same converter and checker run in the browser at [cognocient.com/tools/focus-checker](https://www.cognocient.com/tools/focus-checker).

## Supported exports

| Provider | Files | Status |
|---|---|---|
| Anthropic | Claude Console **Cost** export (platform.claude.com/cost), plus the **Usage** export (platform.claude.com/usage) for token quantities | Tested on real Console exports |
| OpenAI | Usage → Export → **Cost data** (group by line item, 1-day interval), plus the **Completions** activity export for token quantities | Built from OpenAI's documentation; not yet tested on a real export |
| Together AI | Cost analytics → **Download CSV** | Built from Together AI's documentation; not yet tested on a real export |

Bedrock, Vertex AI, Azure OpenAI and the Gemini API bill through their cloud, and those clouds already export FOCUS. Mistral and Groq offer no usage export for most accounts.

The provider and each file's role are detected from the header rows, so the order of the files doesn't matter. If a file isn't recognised, `ai-bill-to-focus detect <file>` says what it looks like. Please open an issue with the header row (no data) so it can be supported.

## What the output contains

- One FOCUS row per day, model and token type: uncached input, cache writes, cache reads and output each get their own `SkuId`, `SkuMeter` and unit price.
- `BilledCost` is always the provider's own dollar figure.
  - **Anthropic:** with both exports, a token row is priced as tokens × Anthropic's public price (cache writes 1.25× or 2× input). The row keeps that exact figure only when it rounds to the Cost export's cents; otherwise it keeps the provider's rounded dollars. `x_PriceSource` says which.
  - **OpenAI:** `input_tokens` already includes cached tokens, so uncached input is `input_tokens - input_cached_tokens`. Token counts fill `ConsumedQuantity` and derive the unit price, but never change a dollar amount. If a joined count implies a price more than 3× away from OpenAI's public price, the count is dropped.
- Provider details that FOCUS has no column for are kept as `x_` columns: workspace, API key, project, line item and so on. `Tags` is a single JSON column, as the spec requires.
- `BillingAccountId` and `BillingAccountName` come from the file when it has them; otherwise set them with `--account-id` and `--account-name`.

## Commands

```
ai-bill-to-focus convert <export.csv>... [-o focus.csv] [--account-id ID] [--account-name NAME]
                                         [--prices prices.json | --offline] [--check]
ai-bill-to-focus check <file.csv> [-v 1.4|1.3|1.2] [-c ai|all|none|LIST] [--json] [--strict]
ai-bill-to-focus check --list-criteria [-v 1.4]
ai-bill-to-focus detect <file.csv>...
```

`check` runs the rule models from the FinOps Foundation's [focus-validator](https://github.com/finopsfoundation/focus-spec-validator) (column presence, types, formats, allowed values and cross-column rules), ported to JavaScript. Rules that need the full validator, such as dynamic rules, are counted and reported, not silently passed. To certify a file, run the official validator as well.

Applicability criteria decide which conditional columns are required. The default, `ai`, declares what a direct AI API bill supports: account naming, tagging, usage measurement, unit pricing and a public price list. Use `--list-criteria` to see the rest.

Exit codes are `0` for OK, `1` for FOCUS errors or a failed conversion, and `2` for bad usage. That makes `check` usable as a CI gate.

## Network use

`convert` for Anthropic and OpenAI downloads the public model price list from `https://api.cognocient.com/api/estimate/models`. The request carries nothing about your files. Use `--offline` to skip it, or `--prices file.json` to provide your own list in the same format. `check`, `detect` and the Together AI converter make no network requests.

## Development

```sh
npm install
npm test        # builds, then runs the CLI on the synthetic exports in test/fixtures
```

`src/lib` holds the checker and converters. They are developed alongside the web tool and synced into this repo, so the CLI and the web page give the same answers. The FOCUS rule JSON in `src/lib/rules-*.json` is generated from the focus-spec-validator rule models. Issues and pull requests are welcome; for a new provider, the export's header row and a few anonymised rows are the most useful thing to include.

## License

MIT. The bundled FOCUS rule data comes from the FinOps Foundation's focus-spec-validator (MIT); see THIRD_PARTY_NOTICES.md. FOCUS is a trademark of the FinOps Foundation; this project is not affiliated with or endorsed by it.
