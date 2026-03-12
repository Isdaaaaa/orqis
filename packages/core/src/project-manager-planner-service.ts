export interface ProjectManagerPlannerRole {
  readonly roleKey: string;
  readonly displayName: string;
  readonly responsibility: string;
}

export interface ProjectManagerPlannerInput {
  readonly goal: string;
  readonly roles: readonly ProjectManagerPlannerRole[];
}

export const PROJECT_MANAGER_WORKFLOW_COMMANDS = [
  "plan",
  "implement",
  "review",
  "integrate",
] as const;

export type ProjectManagerWorkflowCommand =
  (typeof PROJECT_MANAGER_WORKFLOW_COMMANDS)[number];

export interface ProjectManagerPlannedTask {
  readonly ownerRole: string;
  readonly ownerDisplayName: string;
  readonly title: string;
  readonly description: string;
  readonly state: "todo";
}

export interface ProjectManagerPlan {
  readonly goal: string;
  readonly workflowCommand: ProjectManagerWorkflowCommand;
  readonly projectManagerRoleKey: string;
  readonly projectManagerDisplayName: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly statusUpdate: string;
  readonly tasks: readonly ProjectManagerPlannedTask[];
  readonly message: string;
}

export interface ProjectManagerPlannerService {
  planGoal(input: ProjectManagerPlannerInput): ProjectManagerPlan;
}

export class ProjectManagerPlannerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export const PROJECT_MANAGER_PLANNER_ROLE_KEY = "project_manager";

const WORKFLOW_COMMAND_ALIASES: Readonly<Record<string, ProjectManagerWorkflowCommand>> = {
  plan: "plan",
  implement: "implement",
  implementation: "implement",
  review: "review",
  integrate: "integrate",
  integration: "integrate",
};

const WORKFLOW_STEPS_BY_COMMAND: Readonly<
  Record<ProjectManagerWorkflowCommand, readonly string[]>
> = {
  plan: [
    "Capture the requested outcome and keep the first run in planned state.",
    "Split the work into specialist-owned tasks using the saved role responsibilities.",
    "Keep validation visible so execution can start with a clear handoff and review path.",
  ],
  implement: [
    "Treat this run as implementation-focused and keep scope tied to the requested slice.",
    "Route implementation tasks to delivery specialists with explicit ownership.",
    "Post implementation status updates so review can begin from concrete outputs.",
  ],
  review: [
    "Treat this run as review-focused and keep checks tied to the requested slice.",
    "Route review tasks to validation-focused specialists with explicit acceptance criteria.",
    "Post review status updates with findings, risks, and release recommendations.",
  ],
  integrate: [
    "Treat this run as integration-focused and keep scope tied to approved work.",
    "Route integration tasks to merge/release-capable specialists with explicit ownership.",
    "Post integration status updates that confirm readiness or identify blockers.",
  ],
};

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new ProjectManagerPlannerValidationError(
      `${label} must be a non-empty string.`,
    );
  }

  return normalized;
}

function normalizeRole(
  role: ProjectManagerPlannerRole,
  index: number,
): ProjectManagerPlannerRole {
  return {
    roleKey: normalizeRequiredString(role.roleKey, `roles[${index}].roleKey`).toLowerCase(),
    displayName: normalizeRequiredString(
      role.displayName,
      `roles[${index}].displayName`,
    ),
    responsibility: normalizeRequiredString(
      role.responsibility,
      `roles[${index}].responsibility`,
    ),
  };
}

function isProjectManagerRole(role: ProjectManagerPlannerRole): boolean {
  return role.roleKey === PROJECT_MANAGER_PLANNER_ROLE_KEY;
}

function isFrontendRole(role: ProjectManagerPlannerRole): boolean {
  const haystack =
    `${role.roleKey} ${role.displayName} ${role.responsibility}`.toLowerCase();
  return (
    haystack.includes("frontend") ||
    haystack.includes("ui") ||
    haystack.includes("browser")
  );
}

function isBackendRole(role: ProjectManagerPlannerRole): boolean {
  const haystack =
    `${role.roleKey} ${role.displayName} ${role.responsibility}`.toLowerCase();
  return (
    haystack.includes("backend") ||
    haystack.includes("api") ||
    haystack.includes("runtime") ||
    haystack.includes("persistence")
  );
}

function isReviewRole(role: ProjectManagerPlannerRole): boolean {
  const haystack =
    `${role.roleKey} ${role.displayName} ${role.responsibility}`.toLowerCase();
  return (
    haystack.includes("review") ||
    haystack.includes("qa") ||
    haystack.includes("test") ||
    haystack.includes("validate")
  );
}

function isIntegrationRole(role: ProjectManagerPlannerRole): boolean {
  if (isReviewRole(role)) {
    return false;
  }

  const haystack =
    `${role.roleKey} ${role.displayName} ${role.responsibility}`.toLowerCase();
  return (
    haystack.includes("integrat") ||
    haystack.includes("merge") ||
    haystack.includes("release") ||
    haystack.includes("handoff") ||
    haystack.includes("stabiliz")
  );
}

function summarizeGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
}

function createTaskTitle(input: {
  role: ProjectManagerPlannerRole;
  goal: string;
  workflowCommand: ProjectManagerWorkflowCommand;
}): string {
  if (input.workflowCommand === "review") {
    return `Review and validate the delivered work for ${input.goal}.`;
  }

  if (input.workflowCommand === "integrate") {
    return `Integrate and stabilize the delivered work for ${input.goal}.`;
  }

  const role = input.role;

  if (isFrontendRole(role)) {
    return `Design and implement the user-facing flow for ${input.goal}.`;
  }

  if (isBackendRole(role)) {
    return `Implement the runtime and persistence support for ${input.goal}.`;
  }

  if (isReviewRole(role)) {
    return `Validate the delivered work for ${input.goal}.`;
  }

  if (input.workflowCommand === "implement") {
    return `Implement the ${role.displayName} slice for ${input.goal}.`;
  }

  return `Advance the ${role.displayName} slice for ${input.goal}.`;
}

function createTaskDescription(
  role: ProjectManagerPlannerRole,
  goal: string,
): string {
  return `${role.displayName} owns the "${goal}" slice that matches this responsibility: ${role.responsibility}`;
}

function createPlanSummary(
  input: {
    goal: string;
    workflowCommand: ProjectManagerWorkflowCommand;
  },
  tasks: readonly ProjectManagerPlannedTask[],
): string {
  const taskCount = `${tasks.length} specialist task${tasks.length === 1 ? "" : "s"}`;

  if (input.workflowCommand === "plan") {
    return `Create a first-pass delivery plan for "${input.goal}" with ${taskCount} before execution starts.`;
  }

  if (input.workflowCommand === "implement") {
    return `Route "${input.goal}" into the implementation workflow with ${taskCount}.`;
  }

  if (input.workflowCommand === "review") {
    return `Route "${input.goal}" into the review workflow with ${taskCount}.`;
  }

  return `Route "${input.goal}" into the integration workflow with ${taskCount}.`;
}

function createWorkflowStatusUpdate(
  workflowCommand: ProjectManagerWorkflowCommand,
  tasks: readonly ProjectManagerPlannedTask[],
): string {
  const owners = tasks.map((task) => task.ownerDisplayName);

  if (workflowCommand === "plan") {
    return "Planning workflow is complete; specialist tasks are ready for execution.";
  }

  if (workflowCommand === "implement") {
    return `Implementation workflow is active; routed to ${owners.join(", ")}.`;
  }

  if (workflowCommand === "review") {
    return `Review workflow is active; routed to ${owners.join(", ")}.`;
  }

  return `Integration workflow is active; routed to ${owners.join(", ")}.`;
}

function parseGoalWorkflowCommand(inputGoal: string): {
  workflowCommand: ProjectManagerWorkflowCommand;
  goal: string;
} {
  const commandMatch = inputGoal.match(/^([a-z_]+)\s*:\s*(.*)$/i);

  if (commandMatch === null) {
    return {
      workflowCommand: "plan",
      goal: inputGoal,
    };
  }

  const commandAlias = commandMatch[1]?.toLowerCase();
  const requestedGoal = commandMatch[2];

  if (commandAlias === undefined || requestedGoal === undefined) {
    return {
      workflowCommand: "plan",
      goal: inputGoal,
    };
  }

  const workflowCommand = WORKFLOW_COMMAND_ALIASES[commandAlias];

  if (workflowCommand === undefined) {
    return {
      workflowCommand: "plan",
      goal: inputGoal,
    };
  }

  const normalizedGoal = requestedGoal.trim();

  if (normalizedGoal.length === 0) {
    throw new ProjectManagerPlannerValidationError(
      `goal command "${commandAlias}" must include a non-empty objective after ":".`,
    );
  }

  return {
    workflowCommand,
    goal: normalizedGoal,
  };
}

function selectWorkflowRoles(input: {
  workflowCommand: ProjectManagerWorkflowCommand;
  specialistRoles: readonly ProjectManagerPlannerRole[];
}): readonly ProjectManagerPlannerRole[] {
  if (input.workflowCommand === "plan") {
    return input.specialistRoles;
  }

  if (input.workflowCommand === "implement") {
    const implementationRoles = input.specialistRoles.filter(
      (role) => !isReviewRole(role) && !isIntegrationRole(role),
    );

    if (implementationRoles.length === 0) {
      throw new ProjectManagerPlannerValidationError(
        'roles must include at least one implementation specialist role before running "implement:" commands.',
      );
    }

    return implementationRoles;
  }

  if (input.workflowCommand === "review") {
    const reviewRoles = input.specialistRoles.filter(isReviewRole);

    if (reviewRoles.length === 0) {
      throw new ProjectManagerPlannerValidationError(
        'roles must include at least one review specialist role before running "review:" commands.',
      );
    }

    return reviewRoles;
  }

  const integrationRoles = input.specialistRoles.filter(isIntegrationRole);

  if (integrationRoles.length > 0) {
    return integrationRoles;
  }

  const backendIntegrationFallbackRoles = input.specialistRoles.filter(isBackendRole);

  if (backendIntegrationFallbackRoles.length > 0) {
    return backendIntegrationFallbackRoles;
  }

  return input.specialistRoles;
}

function createPlanMessage(input: {
  goal: string;
  projectManagerDisplayName: string;
  workflowCommand: ProjectManagerWorkflowCommand;
  summary: string;
  steps: readonly string[];
  statusUpdate: string;
  tasks: readonly ProjectManagerPlannedTask[];
}): string {
  const sections = [
    `${input.projectManagerDisplayName} plan for: ${input.goal}`,
    "",
    `Workflow command: ${input.workflowCommand}`,
    "",
    `Summary: ${input.summary}`,
    "",
    "Execution outline:",
    ...input.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `Status update: ${input.statusUpdate}`,
    "",
    "Planned tasks:",
    ...input.tasks.map(
      (task, index) =>
        `${index + 1}. ${task.ownerDisplayName}: ${task.title} ${task.description}`,
    ),
  ];

  return sections.join("\n");
}

class DefaultProjectManagerPlannerService
  implements ProjectManagerPlannerService
{
  planGoal(input: ProjectManagerPlannerInput): ProjectManagerPlan {
    const rawGoal = normalizeRequiredString(input.goal, "goal");
    const roles = input.roles.map(normalizeRole);
    const workflowGoal = parseGoalWorkflowCommand(rawGoal);
    const projectManagerRole = roles.find(isProjectManagerRole);

    if (projectManagerRole === undefined) {
      throw new ProjectManagerPlannerValidationError(
        `roles must include the reserved "${PROJECT_MANAGER_PLANNER_ROLE_KEY}" role before planning can start.`,
      );
    }

    const specialistRoles = roles.filter(
      (role) => role.roleKey !== projectManagerRole.roleKey,
    );

    if (specialistRoles.length === 0) {
      throw new ProjectManagerPlannerValidationError(
        "roles must include at least one specialist role in addition to the Project Manager.",
      );
    }

    const selectedRoles = selectWorkflowRoles({
      workflowCommand: workflowGoal.workflowCommand,
      specialistRoles,
    });
    const normalizedGoal = summarizeGoal(workflowGoal.goal);
    const tasks = selectedRoles.map((role) => ({
      ownerRole: role.roleKey,
      ownerDisplayName: role.displayName,
      title: createTaskTitle({
        role,
        goal: normalizedGoal,
        workflowCommand: workflowGoal.workflowCommand,
      }),
      description: createTaskDescription(role, normalizedGoal),
      state: "todo" as const,
    }));
    const summary = createPlanSummary(
      {
        goal: normalizedGoal,
        workflowCommand: workflowGoal.workflowCommand,
      },
      tasks,
    );
    const steps = [...WORKFLOW_STEPS_BY_COMMAND[workflowGoal.workflowCommand]];
    const statusUpdate = createWorkflowStatusUpdate(
      workflowGoal.workflowCommand,
      tasks,
    );

    return {
      goal: rawGoal,
      workflowCommand: workflowGoal.workflowCommand,
      projectManagerRoleKey: projectManagerRole.roleKey,
      projectManagerDisplayName: projectManagerRole.displayName,
      summary,
      steps,
      statusUpdate,
      tasks,
      message: createPlanMessage({
        goal: workflowGoal.goal,
        projectManagerDisplayName: projectManagerRole.displayName,
        workflowCommand: workflowGoal.workflowCommand,
        summary,
        steps,
        statusUpdate,
        tasks,
      }),
    };
  }
}

export function createProjectManagerPlannerService(): ProjectManagerPlannerService {
  return new DefaultProjectManagerPlannerService();
}
