export interface AgentConfigurationDraftProvider {
  readonly providerKey: string;
  readonly displayName: string;
  readonly baseUrl: string;
}

export interface AgentConfigurationDraftModel {
  readonly modelKey: string;
  readonly providerKey: string;
  readonly displayName: string;
}

export interface AgentConfigurationDraftRole {
  readonly roleKey: string;
  readonly displayName: string;
  readonly modelKey: string;
  readonly responsibility: string;
}

export interface AgentConfigurationDraft {
  readonly providers: readonly AgentConfigurationDraftProvider[];
  readonly models: readonly AgentConfigurationDraftModel[];
  readonly agentRoles: readonly AgentConfigurationDraftRole[];
}

export interface AgentConfigurationSelectOption {
  readonly value: string;
  readonly label: string;
}

export function cloneAgentConfigurationDraft(
  configuration: unknown,
): AgentConfigurationDraft {
  const source =
    configuration !== null && typeof configuration === "object"
      ? configuration
      : undefined;

  const providers = Array.isArray((source as { providers?: unknown })?.providers)
    ? ((source as { providers: unknown[] }).providers)
    : [];
  const models = Array.isArray((source as { models?: unknown })?.models)
    ? ((source as { models: unknown[] }).models)
    : [];
  const agentRoles = Array.isArray((source as { agentRoles?: unknown })?.agentRoles)
    ? ((source as { agentRoles: unknown[] }).agentRoles)
    : [];

  return {
    providers: providers.map((provider) => ({
      providerKey:
        provider !== null &&
        typeof provider === "object" &&
        typeof (provider as { providerKey?: unknown }).providerKey === "string"
          ? (provider as { providerKey: string }).providerKey
          : "",
      displayName:
        provider !== null &&
        typeof provider === "object" &&
        typeof (provider as { displayName?: unknown }).displayName === "string"
          ? (provider as { displayName: string }).displayName
          : "",
      baseUrl:
        provider !== null &&
        typeof provider === "object" &&
        typeof (provider as { baseUrl?: unknown }).baseUrl === "string"
          ? (provider as { baseUrl: string }).baseUrl
          : "",
    })),
    models: models.map((model) => ({
      modelKey:
        model !== null &&
        typeof model === "object" &&
        typeof (model as { modelKey?: unknown }).modelKey === "string"
          ? (model as { modelKey: string }).modelKey
          : "",
      providerKey:
        model !== null &&
        typeof model === "object" &&
        typeof (model as { providerKey?: unknown }).providerKey === "string"
          ? (model as { providerKey: string }).providerKey
          : "",
      displayName:
        model !== null &&
        typeof model === "object" &&
        typeof (model as { displayName?: unknown }).displayName === "string"
          ? (model as { displayName: string }).displayName
          : "",
    })),
    agentRoles: agentRoles.map((agentRole) => ({
      roleKey:
        agentRole !== null &&
        typeof agentRole === "object" &&
        typeof (agentRole as { roleKey?: unknown }).roleKey === "string"
          ? (agentRole as { roleKey: string }).roleKey
          : "",
      displayName:
        agentRole !== null &&
        typeof agentRole === "object" &&
        typeof (agentRole as { displayName?: unknown }).displayName === "string"
          ? (agentRole as { displayName: string }).displayName
          : "",
      modelKey:
        agentRole !== null &&
        typeof agentRole === "object" &&
        typeof (agentRole as { modelKey?: unknown }).modelKey === "string"
          ? (agentRole as { modelKey: string }).modelKey
          : "",
      responsibility:
        agentRole !== null &&
        typeof agentRole === "object" &&
        typeof (agentRole as { responsibility?: unknown }).responsibility === "string"
          ? (agentRole as { responsibility: string }).responsibility
          : "",
    })),
  };
}

export function normalizeAgentConfigurationDraft(
  configuration: unknown,
): AgentConfigurationDraft {
  const draft = cloneAgentConfigurationDraft(configuration);

  return {
    providers: draft.providers.map((provider) => ({
      providerKey: provider.providerKey.trim(),
      displayName: provider.displayName,
      baseUrl: provider.baseUrl.trim(),
    })),
    models: draft.models.map((model) => ({
      modelKey: model.modelKey.trim(),
      providerKey: model.providerKey.trim(),
      displayName: model.displayName,
    })),
    agentRoles: draft.agentRoles.map((agentRole) => ({
      roleKey: agentRole.roleKey.trim(),
      displayName: agentRole.displayName,
      modelKey: agentRole.modelKey.trim(),
      responsibility: agentRole.responsibility,
    })),
  };
}

export function buildSelectOptionsWithMissingValue(
  options: readonly AgentConfigurationSelectOption[],
  selectedValue: string,
  missingLabelPrefix: string,
): AgentConfigurationSelectOption[] {
  const normalizedSelectedValue = selectedValue.trim();

  if (
    normalizedSelectedValue.length === 0 ||
    options.some((option) => option.value === normalizedSelectedValue)
  ) {
    return [...options];
  }

  return [
    {
      value: normalizedSelectedValue,
      label: `${missingLabelPrefix}: ${normalizedSelectedValue}`,
    },
    ...options,
  ];
}

export function listDependentModelLabelsForProvider(
  configuration: AgentConfigurationDraft,
  providerKey: string,
): string[] {
  const normalizedProviderKey = providerKey.trim();

  if (normalizedProviderKey.length === 0) {
    return [];
  }

  return configuration.models
    .filter((model) => model.providerKey.trim() === normalizedProviderKey)
    .map((model) => {
      const displayName = model.displayName.trim();
      const modelKey = model.modelKey.trim();
      return displayName.length > 0 ? displayName : modelKey || "(unnamed model)";
    });
}

export function listDependentRoleLabelsForModel(
  configuration: AgentConfigurationDraft,
  modelKey: string,
): string[] {
  const normalizedModelKey = modelKey.trim();

  if (normalizedModelKey.length === 0) {
    return [];
  }

  return configuration.agentRoles
    .filter((agentRole) => agentRole.modelKey.trim() === normalizedModelKey)
    .map((agentRole) => {
      const displayName = agentRole.displayName.trim();
      const roleKey = agentRole.roleKey.trim();
      return displayName.length > 0 ? displayName : roleKey || "(unnamed role)";
    });
}

export function serializeAgentConfigurationEditorClientHelpers(): string {
  return [
    cloneAgentConfigurationDraft,
    normalizeAgentConfigurationDraft,
    buildSelectOptionsWithMissingValue,
    listDependentModelLabelsForProvider,
    listDependentRoleLabelsForModel,
  ]
    .map((helper) => helper.toString())
    .join("\n\n");
}
