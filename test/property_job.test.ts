import assert from "node:assert/strict";
import test from "node:test";
import { decideDelivery } from "../src/property_job.js";

test("routes a valid inspection reminder to processing", () => {
  const decision = decideDelivery({
    kind: "inspection_reminder",
    jobId: "job-104",
    propertyId: "building-7",
    requestedAt: "2026-09-23T08:00:00.000Z",
    inspectionAt: "2026-09-28T09:30:00.000Z",
    recipient: "manager@example.com",
  });

  assert.equal(decision.action, "process");
});

test("marks a tenant document with no object key for dead-letter review", () => {
  const decision = decideDelivery({
    kind: "tenant_document",
    jobId: "job-105",
    propertyId: "building-7",
    tenantId: "tenant-22",
    documentType: "lease",
    objectKey: "",
    requestedAt: "2026-09-23T08:00:00.000Z",
  });

  assert.equal(decision.action, "dead_letter");
  if (decision.action === "dead_letter") assert.match(decision.reason, /too small/i);
});
