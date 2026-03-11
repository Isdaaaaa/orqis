import { ACTOR_TYPES, type ActorType } from "./schema.js";

export const ORQIS_AUDIT_SQL_FUNCTION_NAMES = {
  actorType: "orqis_audit_actor_type",
  actorId: "orqis_audit_actor_id",
  correlationRunId: "orqis_audit_correlation_run_id",
} as const;

export interface OrqisAuditSqlContext {
  readonly actorType?: ActorType | null;
  readonly actorId?: string | null;
  readonly correlationRunId?: string | null;
}

export interface OrqisAuditSqlContextController {
  clearContext(): void;
  getCurrentContext(): Readonly<Required<OrqisAuditSqlContext>> | null;
  runWithContext<T>(context: OrqisAuditSqlContext, run: () => T): T;
}

interface BetterSqliteFunctionRegistrar {
  function(name: string, fn: () => unknown): unknown;
}

interface SqlJsFunctionRegistrar {
  create_function(name: string, fn: () => unknown): unknown;
}

type SupportedSqlFunctionRegistrar =
  | BetterSqliteFunctionRegistrar
  | SqlJsFunctionRegistrar;

type NormalizedOrqisAuditSqlContext = Required<OrqisAuditSqlContext>;

function normalizeOptionalString(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error(`${label} must be a non-empty string when provided.`);
  }

  return normalized;
}

function normalizeActorType(
  actorType: ActorType | null | undefined,
): ActorType | null {
  if (actorType === null || actorType === undefined) {
    return null;
  }

  if (!(ACTOR_TYPES as readonly string[]).includes(actorType)) {
    throw new Error(
      `actorType must be one of: ${ACTOR_TYPES.join(", ")}.`,
    );
  }

  return actorType;
}

function normalizeContext(
  context: OrqisAuditSqlContext,
): NormalizedOrqisAuditSqlContext {
  const actorType = normalizeActorType(context.actorType);
  const actorId = normalizeOptionalString(context.actorId, "actorId");
  const correlationRunId = normalizeOptionalString(
    context.correlationRunId,
    "correlationRunId",
  );

  if (actorId !== null && actorType === null) {
    throw new Error("actorType must be provided when actorId is set.");
  }

  return {
    actorType,
    actorId,
    correlationRunId,
  };
}

function resolveFunctionRegistrar(
  database: SupportedSqlFunctionRegistrar,
): (name: string, fn: () => unknown) => unknown {
  if (
    "function" in database &&
    typeof database.function === "function"
  ) {
    return database.function.bind(database);
  }

  if (
    "create_function" in database &&
    typeof database.create_function === "function"
  ) {
    return database.create_function.bind(database);
  }

  throw new Error(
    "Database does not support registering SQL functions for Orqis audit context.",
  );
}

export function createOrqisAuditSqlContextController(): OrqisAuditSqlContextController {
  let currentContext: NormalizedOrqisAuditSqlContext | null = null;

  return {
    clearContext(): void {
      currentContext = null;
    },
    getCurrentContext(): NormalizedOrqisAuditSqlContext | null {
      return currentContext;
    },
    runWithContext<T>(context: OrqisAuditSqlContext, run: () => T): T {
      const previousContext = currentContext;
      currentContext = normalizeContext(context);

      try {
        return run();
      } finally {
        currentContext = previousContext;
      }
    },
  };
}

export function registerOrqisAuditSqlFunctions(
  database: SupportedSqlFunctionRegistrar,
  getCurrentContext: () => OrqisAuditSqlContext | null | undefined,
): void {
  const register = resolveFunctionRegistrar(database);

  register(ORQIS_AUDIT_SQL_FUNCTION_NAMES.actorType, () => {
    return getCurrentContext()?.actorType ?? null;
  });
  register(ORQIS_AUDIT_SQL_FUNCTION_NAMES.actorId, () => {
    return getCurrentContext()?.actorId ?? null;
  });
  register(ORQIS_AUDIT_SQL_FUNCTION_NAMES.correlationRunId, () => {
    return getCurrentContext()?.correlationRunId ?? null;
  });
}
