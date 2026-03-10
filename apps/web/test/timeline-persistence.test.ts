import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWorkspaceTimelineStore } from "../src/persistence.ts";

describe("@orqis/web workspace timeline persistence", () => {
  it(
    "persists messages across store restarts and keeps chronological workspace ordering",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "orqis-web-timeline-"));
      const databaseFilePath = join(tempDir, "timeline.db");

      const firstStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const firstMessage = firstStore.appendWorkspaceMessage({
          workspaceId: "workspace-alpha",
          projectId: "project-alpha",
          actorType: "user",
          actorId: "alice",
          content: "First timeline update",
        });

        const secondMessage = firstStore.appendWorkspaceMessage({
          workspaceId: "workspace-alpha",
          projectId: "project-alpha",
          actorType: "agent",
          actorId: "pm",
          content: "Second timeline update",
        });

        firstStore.appendWorkspaceMessage({
          workspaceId: "workspace-beta",
          projectId: "project-beta",
          actorType: "user",
          actorId: "bob",
          content: "Workspace beta update",
        });

        expect(firstMessage.createdAt <= secondMessage.createdAt).toBe(true);
      } finally {
        firstStore.close();
      }

      const secondStore = createWorkspaceTimelineStore({
        databaseFilePath,
      });

      try {
        const alphaTimeline = secondStore.listWorkspaceMessages("workspace-alpha");
        const betaTimeline = secondStore.listWorkspaceMessages("workspace-beta");
        const missingTimeline = secondStore.listWorkspaceMessages("workspace-missing");

        expect(alphaTimeline).toHaveLength(2);
        expect(alphaTimeline.map((message) => message.content)).toEqual([
          "First timeline update",
          "Second timeline update",
        ]);
        expect(
          alphaTimeline.every((message) => message.workspaceId === "workspace-alpha"),
        ).toBe(true);

        expect(betaTimeline).toHaveLength(1);
        expect(betaTimeline[0]?.content).toBe("Workspace beta update");

        expect(missingTimeline).toEqual([]);
      } finally {
        secondStore.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
