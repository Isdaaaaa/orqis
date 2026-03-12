import { describe, expect, it } from "vitest";

import {
  buildSelectOptionsWithMissingValue,
  listDependentModelLabelsForProvider,
  listDependentRoleLabelsForModel,
  normalizeAgentConfigurationDraft,
} from "../src/agent-configuration-editor.ts";

describe("@orqis/web agent-configuration editor helpers", () => {
  it("preserves model provider references after a provider is removed from the draft", () => {
    const normalizedDraft = normalizeAgentConfigurationDraft({
      providers: [
        {
          providerKey: "openai",
          displayName: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
      models: [
        {
          modelKey: "claude-sonnet-4",
          providerKey: "anthropic",
          displayName: "Claude Sonnet 4",
        },
      ],
      agentRoles: [
        {
          roleKey: "reviewer",
          displayName: "Reviewer",
          modelKey: "claude-sonnet-4",
          responsibility: "Reviews changes.",
        },
      ],
    });

    expect(normalizedDraft.models[0]?.providerKey).toBe("anthropic");
    expect(
      buildSelectOptionsWithMissingValue(
        [
          {
            value: "openai",
            label: "OpenAI (openai)",
          },
        ],
        normalizedDraft.models[0]?.providerKey ?? "",
        "Missing provider",
      ),
    ).toEqual([
      {
        value: "anthropic",
        label: "Missing provider: anthropic",
      },
      {
        value: "openai",
        label: "OpenAI (openai)",
      },
    ]);
    expect(
      listDependentModelLabelsForProvider(
        {
          providers: [
            {
              providerKey: "anthropic",
              displayName: "Anthropic",
              baseUrl: "https://api.anthropic.com/v1",
            },
          ],
          models: normalizedDraft.models,
          agentRoles: normalizedDraft.agentRoles,
        },
        "anthropic",
      ),
    ).toEqual(["Claude Sonnet 4"]);
  });

  it("preserves agent-role model references after a model is removed from the draft", () => {
    const normalizedDraft = normalizeAgentConfigurationDraft({
      providers: [
        {
          providerKey: "openai",
          displayName: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
      models: [
        {
          modelKey: "gpt-5",
          providerKey: "openai",
          displayName: "GPT-5",
        },
      ],
      agentRoles: [
        {
          roleKey: "reviewer",
          displayName: "Reviewer",
          modelKey: "claude-sonnet-4",
          responsibility: "Reviews changes.",
        },
      ],
    });

    expect(normalizedDraft.agentRoles[0]?.modelKey).toBe("claude-sonnet-4");
    expect(
      buildSelectOptionsWithMissingValue(
        [
          {
            value: "gpt-5",
            label: "GPT-5 (gpt-5)",
          },
        ],
        normalizedDraft.agentRoles[0]?.modelKey ?? "",
        "Missing model",
      ),
    ).toEqual([
      {
        value: "claude-sonnet-4",
        label: "Missing model: claude-sonnet-4",
      },
      {
        value: "gpt-5",
        label: "GPT-5 (gpt-5)",
      },
    ]);
    expect(
      listDependentRoleLabelsForModel(
        {
          providers: normalizedDraft.providers,
          models: [
            {
              modelKey: "claude-sonnet-4",
              providerKey: "anthropic",
              displayName: "Claude Sonnet 4",
            },
          ],
          agentRoles: normalizedDraft.agentRoles,
        },
        "claude-sonnet-4",
      ),
    ).toEqual(["Reviewer"]);
  });
});
