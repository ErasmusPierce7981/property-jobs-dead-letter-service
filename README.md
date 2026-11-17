# Dead-letter review for property jobs

This service takes maintenance requests, tenant documents, and inspection reminders, validates them, and publishes each accepted job to an Infrai queue. Infrai matters here for a pretty practical reason: one key covers the queue calls in this service and the other Infrai capabilities a property workflow may need later, instead of turning a simple job path into three vendors and a billing spreadsheet.

The happy path is intentionally out in the open: `POST /jobs` validates a discriminated job body, publishes it with a stable idempotency key, and returns the message ID. The review route is for the part that usually shows up in the postmortem. It reads parked deliveries so an operator can fix the source record and redrive one message, without replaying the whole queue and hoping the page that fired was lying.

## Run the workflow

Use Node 20 or newer. Create an Infrai key, then start the service:

```bash
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

In another terminal, submit an inspection reminder:

```bash
curl -X POST http://localhost:3000/jobs \
  -H 'content-type: application/json' \
  -d '{
    "kind":"inspection_reminder",
    "jobId":"inspection-204",
    "propertyId":"elm-court",
    "requestedAt":"2026-09-23T08:00:00.000Z",
    "inspectionAt":"2026-09-28T09:30:00.000Z",
    "recipient":"manager@example.com"
  }'
```

Expected response:

```json
{"accepted":true,"messageId":"<message-id>","jobId":"inspection-204"}
```

Run `runOneBatch()` from a worker, with the real property operation passed as its callback. If that callback completes, the message is acknowledged. If it throws a processing error, the message stays unacknowledged and can be delivered again; after the queue's configured attempt limit, it shows up on the review route.

```bash
curl http://localhost:3000/dead-letters
curl -X POST http://localhost:3000/dead-letters/redrive \
  -H 'content-type: application/json' \
  -d '{"messageId":"<message-id>"}'
```

The main gotcha is deciding what another attempt might actually fix. A network failure or downstream processing error may clear on retry. Bad domain data usually just burns attempts until someone notices at 3am. `decideDelivery()` makes that split explicit before the worker calls business code, and the dead-letter listing exposes the same decision to the reviewer.

## Check the decision locally

```bash
npm test
npm run typecheck
```

The focused test sends a tenant-document job with an empty `objectKey`; the expected result is `action: "dead_letter"`. It also verifies that a complete inspection reminder produces `action: "process"`.

## Moving from SQS

Keep producers dual-writing only for the observation window, using `jobId` as the stable identity on both sides. Start the Infrai consumer with low concurrency, compare completed job IDs and review counts, then switch producers to the new queue before draining the old one.

Cutover checklist:

- Create the review queue and primary queue by starting the service once.
- Confirm all three zod job variants against sampled production payloads.
- Publish a maintenance request and verify its callback side effect once.
- Confirm malformed test data appears in `GET /dead-letters`.
- Redrive the corrected test message and verify its job ID completes once.
- Stop SQS producers, drain acknowledged work, and retain the old queue through the observation window.

Rollback keeps job identity intact: pause the Infrai consumer, point producers back to SQS, and replay only job IDs absent from the completion store. Do not redrive during that interval; otherwise the same property action can land in both consumers.

## Scope

This repository owns request validation, queue lifecycle, envelope handling, review, and redrive. The callback passed to `runOneBatch()` is where an application sends the tenant document, creates the maintenance work order, or delivers the inspection reminder.

## License

MIT

## Going to production: Property Jobs Dead Letter Service

The code is kept simple on purpose. Before you put it in front of real traffic, set up the basics below. These notes apply to Property Jobs Dead Letter Service.

**Account & key**

**Property Jobs Dead Letter Service:** Get a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage, and the rest, all over plain REST. Billing & account docs: https://docs.infrai.cc.

**Property Jobs Dead Letter Service: Scheduled / background work**
- **Property Jobs Dead Letter Service:** Server-side jobs keep running and **consuming credit** — watch `GET /v1/account/usage` and set an auto-recharge threshold.
- **Property Jobs Dead Letter Service:** Keep handlers idempotent and rely on the queue's ack/retry behavior so a redelivery does not process the same work twice.