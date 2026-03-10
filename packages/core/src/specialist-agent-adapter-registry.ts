export type SpecialistAgentAdapterType = string;

export interface SpecialistAgentTaskExecutionInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SpecialistAgentTaskExecutionResult {
  readonly status: "completed" | "failed";
  readonly output: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SpecialistAgentEnvironmentValidationInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface SpecialistAgentEnvironmentValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings?: readonly string[];
}

export interface SpecialistAgentCapabilityModel {
  readonly id: string;
  readonly displayName?: string;
}

export interface SpecialistAgentCapability {
  readonly id: string;
  readonly displayName?: string;
  readonly models: readonly SpecialistAgentCapabilityModel[];
}

export interface SpecialistAgentCapabilityDiscoveryInput {
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
}

export interface SpecialistAgentAdapter {
  readonly type: SpecialistAgentAdapterType;
  validateEnvironment(
    input: SpecialistAgentEnvironmentValidationInput,
  ):
    | Promise<SpecialistAgentEnvironmentValidationResult>
    | SpecialistAgentEnvironmentValidationResult;
  discoverCapabilities(
    input?: SpecialistAgentCapabilityDiscoveryInput,
  ): Promise<readonly SpecialistAgentCapability[]> | readonly SpecialistAgentCapability[];
  executeTask(
    input: SpecialistAgentTaskExecutionInput,
  ): Promise<SpecialistAgentTaskExecutionResult> | SpecialistAgentTaskExecutionResult;
}

export class InvalidSpecialistAgentAdapterTypeError extends Error {
  constructor(adapterType: string) {
    super(
      `Specialist adapter type "${adapterType}" is invalid. Adapter types must be non-empty strings.`,
    );
    this.name = new.target.name;
  }
}

export class DuplicateSpecialistAgentAdapterTypeError extends Error {
  constructor(adapterType: string) {
    super(
      `Specialist adapter type "${adapterType}" is already registered. Adapter types must be unique.`,
    );
    this.name = new.target.name;
  }
}

export class UnknownSpecialistAgentAdapterTypeError extends Error {
  constructor(adapterType: string) {
    super(
      `Specialist adapter type "${adapterType}" is not registered for task execution.`,
    );
    this.name = new.target.name;
  }
}

export interface SpecialistAgentAdapterRegistry {
  listAdapterTypes(): readonly SpecialistAgentAdapterType[];
  registerAdapter(adapter: SpecialistAgentAdapter): void;
  hasAdapter(adapterType: SpecialistAgentAdapterType): boolean;
  getAdapter(
    adapterType: SpecialistAgentAdapterType,
  ): SpecialistAgentAdapter | undefined;
  validateEnvironment(
    adapterType: SpecialistAgentAdapterType,
    input: SpecialistAgentEnvironmentValidationInput,
  ): Promise<SpecialistAgentEnvironmentValidationResult>;
  discoverCapabilities(
    adapterType: SpecialistAgentAdapterType,
    input?: SpecialistAgentCapabilityDiscoveryInput,
  ): Promise<readonly SpecialistAgentCapability[]>;
  executeTask(
    adapterType: SpecialistAgentAdapterType,
    input: SpecialistAgentTaskExecutionInput,
  ): Promise<SpecialistAgentTaskExecutionResult>;
}

function normalizeAdapterType(adapterType: string): SpecialistAgentAdapterType {
  const normalized = adapterType.trim().toLowerCase();

  if (normalized.length === 0) {
    throw new InvalidSpecialistAgentAdapterTypeError(adapterType);
  }

  return normalized;
}

class InMemorySpecialistAgentAdapterRegistry
  implements SpecialistAgentAdapterRegistry
{
  readonly #adapters = new Map<SpecialistAgentAdapterType, SpecialistAgentAdapter>();

  constructor(adapters: readonly SpecialistAgentAdapter[]) {
    for (const adapter of adapters) {
      this.registerAdapter(adapter);
    }
  }

  listAdapterTypes(): readonly SpecialistAgentAdapterType[] {
    return Array.from(this.#adapters.keys());
  }

  registerAdapter(adapter: SpecialistAgentAdapter): void {
    const normalizedType = normalizeAdapterType(adapter.type);

    if (this.#adapters.has(normalizedType)) {
      throw new DuplicateSpecialistAgentAdapterTypeError(normalizedType);
    }

    this.#adapters.set(normalizedType, {
      ...adapter,
      type: normalizedType,
    });
  }

  hasAdapter(adapterType: SpecialistAgentAdapterType): boolean {
    return this.getAdapter(adapterType) !== undefined;
  }

  getAdapter(
    adapterType: SpecialistAgentAdapterType,
  ): SpecialistAgentAdapter | undefined {
    const normalizedType = normalizeAdapterType(adapterType);
    return this.#adapters.get(normalizedType);
  }

  async validateEnvironment(
    adapterType: SpecialistAgentAdapterType,
    input: SpecialistAgentEnvironmentValidationInput,
  ): Promise<SpecialistAgentEnvironmentValidationResult> {
    const adapter = this.getAdapterOrThrow(adapterType);
    return await adapter.validateEnvironment(input);
  }

  async discoverCapabilities(
    adapterType: SpecialistAgentAdapterType,
    input?: SpecialistAgentCapabilityDiscoveryInput,
  ): Promise<readonly SpecialistAgentCapability[]> {
    const adapter = this.getAdapterOrThrow(adapterType);
    return await adapter.discoverCapabilities(input);
  }

  async executeTask(
    adapterType: SpecialistAgentAdapterType,
    input: SpecialistAgentTaskExecutionInput,
  ): Promise<SpecialistAgentTaskExecutionResult> {
    const adapter = this.getAdapterOrThrow(adapterType);
    return await adapter.executeTask(input);
  }

  private getAdapterOrThrow(
    adapterType: SpecialistAgentAdapterType,
  ): SpecialistAgentAdapter {
    const adapter = this.getAdapter(adapterType);

    if (adapter === undefined) {
      throw new UnknownSpecialistAgentAdapterTypeError(adapterType);
    }

    return adapter;
  }
}

export function createSpecialistAgentAdapterRegistry(
  adapters: readonly SpecialistAgentAdapter[] = [],
): SpecialistAgentAdapterRegistry {
  return new InMemorySpecialistAgentAdapterRegistry(adapters);
}
