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
| `src/lib/providers.ts` | model call | The only file that knows which model is running. Swap models with one env var. |
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
- **Bedrock model access enabled** — see below. This is the single most common
  reason a first run fails, and it fails *late*: OCR succeeds, then the
  extraction step returns 403.

#### Enabling Bedrock model access

Serverless foundation models now auto-enable on first invocation, so there is
usually no toggle to flip. **Anthropic models are the exception**: first-time
users must submit a short *use case details* form before any invocation
succeeds. Until that's done, calls fail with
`403 permission_error: … is not available for this account`.

Being able to *see* a model in the catalogue proves nothing — every account
sees every model. These two commands are the real diagnostics:

```bash
# 1. Has the Anthropic use-case form been submitted?
aws bedrock get-use-case-for-model-access --region us-east-1
#    ResourceNotFoundException "You have not filled out the request form" = this is your blocker

# 2. Is the model actually usable?
aws bedrock get-foundation-model-availability \
  --model-id anthropic.claude-opus-5 --region us-east-1 \
  --query 'agreementAvailability.status' --output text
#    AVAILABLE = good | NOT_AVAILABLE = blocked
```

`bootstrap.sh` runs check 2 and reports it.

To submit the form, go to **Bedrock console → Model access** for your region
and look for **Submit use case details** (not the per-model toggles):

```
https://console.aws.amazon.com/bedrock/home?region=us-east-1#/modelaccess
```

It asks for company name, website, industry, and a sentence on intended use.
There is a CLI equivalent (`put-use-case-for-model-access --form-data`), but
the payload is an opaque blob the console generates — use the console.

Access is **per region**. To see pricing before committing, run
`aws bedrock list-foundation-model-agreement-offers --model-id <model>
--region <region>` — it prints the full rate card.

#### Keep every service in one region

Textract can only read an S3 object in **its own region**. If your AWS CLI
default region differs from the region in `.env.local`, resources end up split
and OCR fails with a misleading `InvalidS3ObjectException` about object
permissions. `bootstrap.sh` warns when it detects this. Any manual `aws`
command against these resources needs an explicit `--region`.

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

> `.env.local` is read **once, at dev-server startup**. If you create or edit it
> while `npm run dev` is running, restart the server or nothing will change.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Missing required environment variable IDP_TABLE` | No `.env.local`, or it was created after the dev server started. Run `./infra/bootstrap.sh`, paste the output, restart. |
| `AWS credentials are missing or expired` | Re-authenticate (`aws sso login`), then reload the page. |
| `403 permission_error … not available for this account` | The Anthropic use-case form hasn't been submitted. Run `aws bedrock get-use-case-for-model-access --region <region>` to confirm, then submit it in the console. |
| S3 rejects the upload (CORS) | The bucket allows `http://localhost:3000` only. Re-run `bootstrap.sh`, or add your origin to the CORS rule. |
| Textract rejects the file | Multi-page PDF. The sync API is single-page — see "Known limits". |

### IAM permissions

Whatever principal you're running as needs:

```
s3:PutObject, s3:GetObject              on the bucket
dynamodb:GetItem, PutItem,
          UpdateItem, Query             on the table + its index
textract:AnalyzeDocument
bedrock:InvokeModel                     on the Anthropic model
```

### Choosing a model

`BEDROCK_MODEL_ID` selects both the model *and* the API used to reach it —
`providers.ts` dispatches on the id, and nothing else in the codebase changes:

| Id prefix | API | Structured output via |
| --- | --- | --- |
| `anthropic.*` | Messages API (Mantle) | `output_config.format` — native |
| anything else | Converse | a single forced tool call |

Anthropic models need the one-time use-case form above. **Amazon Nova needs
no form**, so it is the quickest way to see the pipeline work:

```bash
BEDROCK_MODEL_ID=amazon.nova-pro-v1:0     # verified working end-to-end
```

Switching back is one line in `.env.local` plus a dev-server restart.

Note the Converse path is the lowest common denominator: forcing a tool call
gets you the same schema guarantee, but it is a workaround where Anthropic's
structured outputs are a first-class feature. Both paths are exercised by the
same pipeline code.

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
- Dev server boots; UI renders; API surfaces failures as actionable JSON
  messages — verified against a live expired-credential error, a
  missing-`.env.local` run, and a live Bedrock 403
- **Upload → S3 → Textract verified end-to-end against live AWS.** A real
  invoice PDF was registered, uploaded via presigned PUT, and OCR'd
  successfully (~6s). Extraction is the one stage still unverified: it is
  blocked on Bedrock model access, not on code.

The extraction stage has **not** been exercised against a live model — the
account's Anthropic use-case form was still unsubmitted, so every Bedrock call
returned 403. Everything upstream of it is confirmed working against real AWS.
Once model access is granted, the first real document is yours to run.
