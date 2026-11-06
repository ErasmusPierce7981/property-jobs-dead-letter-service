import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InfraiError, infrai } from "./infrai.js";
import { decideDelivery, propertyJobSchema } from "./property_job.js";

const QUEUE = process.env.PROPERTY_QUEUE ?? "property-jobs";
const DLQ = process.env.PROPERTY_DLQ ?? "property-jobs-review";
const PORT = Number(process.env.PORT ?? 3000);

const redriveSchema = z.object({ messageId: z.string().min(1) });

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "POST" && request.url === "/jobs") {
    const job = propertyJobSchema.parse(await readJson(request));
    const result = await infrai.queue.publish({
      queue: QUEUE,
      payload: job,
      idempotency_key: `property-job:${job.jobId}`,
    });
    send(response, 202, { accepted: true, messageId: result.message_id, jobId: job.jobId });
    return;
  }

  if (request.method === "GET" && request.url === "/dead-letters") {
    const result = await infrai.queue.dlq.list(DLQ);
    const items = result.items.map((message) => ({
      messageId: message.message_id,
      deliveryCount: message.delivery_count,
      decision: decideDelivery(message.payload),
    }));
    send(response, 200, { items });
    return;
  }

  if (request.method === "POST" && request.url === "/dead-letters/redrive") {
    const { messageId } = redriveSchema.parse(await readJson(request));
    await infrai.queue.dlq.redrive(DLQ, messageId, `redrive:${messageId}`);
    send(response, 202, { redriven: true, messageId });
    return;
  }

  send(response, 404, { error: "Route not found" });
}

export async function ensureQueues(): Promise<void> {
  await infrai.queue.create({ name: DLQ, idempotency_key: `queue:${DLQ}` });
  await infrai.queue.create({
    name: QUEUE,
    dead_letter_queue: DLQ,
    max_retries: 3,
    visibility_timeout_default: 30,
    idempotency_key: `queue:${QUEUE}`,
  });
}

export async function runOneBatch(
  processJob: (job: z.infer<typeof propertyJobSchema>) => Promise<void>,
): Promise<{ completed: number; deferred: number }> {
  const batch = await infrai.queue.consume({
    queue: QUEUE,
    max_messages: 10,
    visibility_timeout: 30,
  });
  let completed = 0;
  let deferred = 0;

  for (const message of batch.items) {
    const decision = decideDelivery(message.payload);
    if (decision.action === "dead_letter") {
      deferred += 1;
      continue;
    }
    try {
      await processJob(decision.job);
      await infrai.queue.ack({
        queue: QUEUE,
        message_id: message.message_id,
        idempotency_key: `ack:${message.message_id}`,
      });
      completed += 1;
    } catch {
      deferred += 1;
    }
  }
  return { completed, deferred };
}

function clientStatus(error: InfraiError): number {
  return error.status >= 400 && error.status < 500 ? error.status : 502;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureQueues();
  createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        send(response, 400, { error: "Invalid request body" });
      } else if (error instanceof InfraiError) {
        send(response, clientStatus(error), { error: error.code, message: error.message });
      } else {
        const incidentId = randomUUID();
        console.error({ incidentId, error });
        send(response, 502, { error: "Request could not be completed", incidentId });
      }
    });
  }).listen(PORT, () => console.log(`Property queue service listening on http://localhost:${PORT}`));
}
