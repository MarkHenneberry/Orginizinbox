import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("persistent database architecture", () => {
  it("does not define persistent mailbox-derived Prisma models", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");

    expect(schema).not.toMatch(/model\s+MessageMetadata/);
    expect(schema).not.toMatch(/model\s+SenderAggregate/);
    expect(schema).not.toMatch(/model\s+CleanupGroup/);
    expect(schema).not.toMatch(/providerMessageId|senderKey|senderDomain|providerLabels|threadId/);
  });
});
