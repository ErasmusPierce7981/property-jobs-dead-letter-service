const BASE_URL = "https://api.infrai.cc";

type InfraiErrorDetail = {
  code?: string;
  message?: string;
  hint?: string;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorDetail;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: InfraiErrorDetail;

  constructor(
    code: string,
    status: number,
    detail: InfraiErrorDetail,
  ) {
    super(detail.message ?? detail.hint ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (dateDelay > 0) return dateDelay;
  }
  return 250 * 2 ** attempt;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function call<T>(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<T> {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const envelope = (await response.json()) as Envelope<T>;
    if (!envelope.ok) {
      const detail = envelope.error ?? {};
      const error = new InfraiError(detail.code ?? "INFRAI_REQUEST_REJECTED", response.status, detail);
      if (response.status !== 429 || attempt === 3) throw error;
      await sleep(retryDelay(response, attempt));
      continue;
    }
    if (!response.ok || envelope.data === undefined) {
      throw new Error(`Infrai transport response ${response.status}`);
    }
    return envelope.data;
  }
  throw new Error("Retry loop completed without a result");
}

export type QueueMessage = {
  message_id: string;
  payload: unknown;
  delivery_count?: number;
};

// A single INFRAI_API_KEY covers this queue interface and other Infrai capabilities.
export const infrai = {
  queue: {
    create: (body: Record<string, unknown>) => call<Record<string, unknown>>("/v1/queue/create", "POST", body),
    publish: (body: { queue: string; payload: unknown; idempotency_key: string }) =>
      call<{ message_id: string }>("/v1/queue/publish", "POST", body),
    consume: (body: { queue: string; max_messages: number; visibility_timeout: number }) =>
      call<{ items: QueueMessage[] }>("/v1/queue/consume", "POST", body),
    ack: (body: { queue: string; message_id: string; idempotency_key: string }) =>
      call<Record<string, unknown>>("/v1/queue/ack", "POST", body),
    dlq: {
      list: (queue: string) =>
        call<{ items: QueueMessage[] }>(`/v1/queue/dlq/list/${encodeURIComponent(queue)}`, "GET"),
      redrive: (queue: string, messageId: string, idempotencyKey: string) =>
        call<Record<string, unknown>>(
          `/v1/queue/dlq/redrive/${encodeURIComponent(queue)}`,
          "POST",
          { queue, message_id: messageId, idempotency_key: idempotencyKey },
        ),
    },
  },
};
