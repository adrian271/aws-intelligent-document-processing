# Intelligent Document Processing — AWS proof of concept

A working IDP pipeline in about 1,200 lines: upload a document, OCR it, classify
it, extract typed fields with confidence scores, run validation rules, and route
anything uncertain to a human reviewer.

The point of this repo is to make the *mechanics* legible. Every stage is a
separate file you can read top to bottom, and the interesting decisions —
how confidence is computed, how hallucinations are caught, what makes a document
need review — are in the code rather than hidden behind a managed service.

```
   browser
      │  presigned PUT
      ▼
   ┌─────┐    ┌──────────┐    ┌────────────────┐    ┌──────────┐
   │ S3  │──▶│ Textract │──▶│ Claude/Bedrock │──▶│ DynamoDB │
   └─────┘    └──────────┘    └────────────────┘    └──────────┘
              OCR + forms      classify + map        one item
              + tables         to typed schema       per document
              (+OCR conf)      (+model conf)               │
                                     │                     ▼
                              grounding check        review UI
                              confidence fusion      corrections
                              validation rules       approve/reject
```

---

## What each piece actually does

| File | Stage | What to look at |
| --- | --- | --- |
| `src/lib/schemas.ts` | config | Document types and their fields. **Start here** — everything else is generated from it. |
| `src/lib/textract.ts` | OCR | Walking Textract's block *graph* into text, key/value pairs and tables. |
| `src/lib/extract.ts` | classify + extract | Building a JSON Schema from the config, and the grounding check. |
| `src/lib/pipeline.ts` | orchestration | Confidence fusion — the ~20 lines that decide what a human sees. |
| `src/lib/validate.ts` | rules | Turning "low confidence" and "doesn't add up" into an exception queue. |
| `src/components/ReviewScreen.tsx` | human loop | Corrections, audit trail, approve/reject gating. |

### The three ideas worth understanding

**1. Two independent confidence signals, combined pessimistically.**

Textract gives an *OCR* confidence: how sure it is it read those characters
correctly. The model gives a *semantic* confidence: how sure it is that this is
the right value for this field. They fail in different ways — perfect OCR of the
wrong number, or a confident model reading smudged characters — so
`fuseConfidence()` in `pipeline.ts` takes the **minimum**. A field is only as
trustworthy as its weakest link.

**2. Grounding, as a hallucination guard.**

The model must return the verbatim `sourceText` it read each value from. We
then check that text actually appears in the OCR output
(`isGrounded()` in `extract.ts`). A value the model invented can't survive that
check — it gets capped at 0.5 confidence, tagged `inferred`, and raises an
`UNGROUNDED_VALUE` exception. This is the concrete answer to "how do you stop it
making things up", and it costs about fifteen lines.

**3. Confidence and validation are different signals.**

Confidence says how sure the machine is about one field. Validation says whether
the fields are *coherent together* — a total that doesn't equal subtotal plus
tax is wrong even if every number scored 0.99. Both feed the same review queue,
and `CONFIDENCE_THRESHOLD` is the single dial trading accuracy against how much
human time you spend.

---

## Running it

### Prerequisites

- Node 20+
- AWS CLI, authenticated (`aws sts get-caller-identity` should succeed)
- **Bedrock model access enabled** for Anthropic models in your region —
  this is a one-time click-through in the
  [Bedrock console](https://console.aws.amazon.com/bedrock/home#/modelaccess).
  It is the single most common reason a first run fails.

### Setup

```bash
./infra/bootstrap.sh              # creates the S3 bucket + DynamoDB table
# copy the printed block into .env.local
npm install
npm run dev                       # http://localhost:3000
```

Then drop a single-page invoice or receipt (PDF/PNG/JPEG/TIFF) onto the page.
First run takes ~10–30 seconds: OCR, then a model call.

`bootstrap.sh` is safe to re-run and only creates what's missing.

### IAM permissions

Whatever principal you're running as needs:

```
s3:PutObject, s3:GetObject              on the bucket
dynamodb:GetItem, PutItem,
          UpdateItem, Query             on the table + its index
textract:AnalyzeDocument
bedrock:InvokeModel                     on the Anthropic model
```

---

## Cost

Genuinely near-zero at POC volume, but the parts aren't equal — worth knowing
which is which:

| Service | Free tier | After that |
| --- | --- | --- |
| S3 | 5 GB (12-month tier) | ~$0.023/GB/month |
| DynamoDB | 25 GB + 25 RCU/WCU — **always free** | on-demand per request |
| Lambda | 1M requests/month — **always free** | negligible here |
| Textract | 1,000 pages/mo for 3 months | ~$0.05/page with FORMS+TABLES |
| **Bedrock** | **no free tier** | **pay per token from call #1** |

Bedrock is the only line item that is never free. A one-page invoice through
Opus 5 runs roughly 3–5k input and ~1k output tokens — a few cents per
document. Fine for learning; the dial to turn if you batch-process hundreds is
`BEDROCK_MODEL_ID` (drop to `anthropic.claude-sonnet-5`) plus
`output_config.effort` in `extract.ts`.

> **AWS changed the free tier in July 2025.** New accounts get credits with a
> ~6-month window instead of the old 12-month tier; older accounts were
> grandfathered. Check which yours is before leaning on any intro allowance.
> The always-free services above are unaffected either way.

The S3 lifecycle rule expires uploads after 30 days so storage never
accumulates. To remove everything:

```bash
aws s3 rm "s3://$IDP_BUCKET" --recursive && aws s3api delete-bucket --bucket "$IDP_BUCKET"
aws dynamodb delete-table --table-name "$IDP_TABLE"
```

---

## Known limits of the POC

These are deliberate — each one is a place where the simple version is clearer
than the correct one.

- **Single-page documents only.** Textract's synchronous `AnalyzeDocument`
  handles one page. Multi-page PDFs need the asynchronous
  `StartDocumentAnalysis` → SNS → `GetDocumentAnalysis` flow. The error message
  says so explicitly rather than failing mysteriously.
- **Processing runs inline in the request.** One request, one visible result,
  no queue to reason about. It also means a slow document holds an HTTP
  connection open for 30 seconds.
- **No auth.** Anyone who can reach the app can read every document. The job
  description this was modelled on lists OAuth/OIDC and role-based access as
  requirements — that's the first thing you'd add.
- **Confidence fusion is a heuristic**, not a calibrated probability. It's
  tuned to be conservative (over-flag rather than under-flag), which is the
  right bias for review workflows but means the numbers aren't comparable
  across document types.
- **Table extraction is passed through mostly unvalidated** — line items are
  displayed but not reconciled against the subtotal.

### Scaling past the POC

The rough order you'd change things, and why:

1. **Make processing asynchronous.** S3 `ObjectCreated` event → SQS → Lambda
   worker. Removes the connection-held-open problem and gives you retries for
   free.
2. **Switch to async Textract** for multi-page documents.
3. **Add auth** and scope the document list per user/tenant.
4. **Add a Step Functions state machine** once the pipeline grows a branch
   (different flows per document type, or a second extraction pass on failure).
   Not before — Step Functions costs more in ceremony than it saves at three
   linear stages.
5. **Mine the `corrections` array.** Every human edit is recorded with its
   before/after. Aggregated, that tells you which fields the extractor is
   chronically bad at, which is where prompt or schema work actually pays off.

---

## Phase 5 — deploying to Lambda (not yet run)

Everything above runs locally against real AWS services. Nothing in the code
needs to change to deploy: credentials come from the default provider chain, so
the Lambda execution role slots in where your local credentials are now.

The always-free path is **CloudFront + Lambda**, via
[OpenNext](https://opennext.js.org/aws) (which compiles a Next.js app into
Lambda handlers) driven by SST:

```bash
npm install --save-dev sst
npx sst init                     # detects Next.js, writes sst.config.ts
npx sst deploy --stage prod
```

Then in `sst.config.ts`, grant the function the same permissions listed above
and pass through `IDP_BUCKET` / `IDP_TABLE` / `BEDROCK_REGION` as environment
variables. Two things to fix up after the first deploy:

- **Add the CloudFront domain to the bucket's CORS `AllowedOrigins`** — it's
  currently `http://localhost:3000` only, and presigned uploads will fail from
  the deployed origin until you do.
- **Check the function timeout** covers the pipeline. `maxDuration = 300` is
  set on the process route; the Lambda itself needs a matching timeout.

Why this rather than Amplify Hosting: Lambda's 1M requests/month and
CloudFront's 1 TB egress are **always free** with no expiry, whereas Amplify
Hosting bills per build-minute and per GB served once its introductory period
ends. More setup, but genuinely $0 indefinitely at this volume.

---

## Verified

- `npm run typecheck` — clean
- `npm run build` — clean, all routes correctly dynamic
- Dev server boots; UI renders; API surfaces AWS failures as actionable
  messages (verified against a live expired-credential error)

The pipeline has **not** been run end-to-end against live Textract and Bedrock —
the AWS session in this environment was expired, so that first real document is
yours to run.
