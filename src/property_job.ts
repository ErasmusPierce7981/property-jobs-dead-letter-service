import { z } from "zod";

const jobBase = z.object({
  jobId: z.string().min(1),
  propertyId: z.string().min(1),
  requestedAt: z.iso.datetime(),
});

const maintenanceRequest = jobBase.extend({
  kind: z.literal("maintenance_request"),
  unit: z.string().min(1),
  summary: z.string().min(3),
  accessApproved: z.boolean(),
});

const tenantDocument = jobBase.extend({
  kind: z.literal("tenant_document"),
  tenantId: z.string().min(1),
  documentType: z.enum(["lease", "insurance", "move_in_report"]),
  objectKey: z.string().min(1),
});

const inspectionReminder = jobBase.extend({
  kind: z.literal("inspection_reminder"),
  inspectionAt: z.iso.datetime(),
  recipient: z.string().email(),
});

export const propertyJobSchema = z.discriminatedUnion("kind", [
  maintenanceRequest,
  tenantDocument,
  inspectionReminder,
]);

export type PropertyJob = z.infer<typeof propertyJobSchema>;

export type DeliveryDecision =
  | { action: "process"; job: PropertyJob }
  | { action: "dead_letter"; reason: string };

/** Invalid domain data cannot become valid on another delivery, so it belongs in review. */
export function decideDelivery(payload: unknown): DeliveryDecision {
  const parsed = propertyJobSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      action: "dead_letter",
      reason: parsed.error.issues.map((issue) => issue.message).join("; "),
    };
  }
  return { action: "process", job: parsed.data };
}
