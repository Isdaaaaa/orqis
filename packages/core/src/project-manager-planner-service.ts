export interface ProjectManagerPlannerRole {
  readonly roleKey: string;
  readonly displayName: string;
  readonly responsibility: string;
}

export interface ProjectManagerPlannerInput {
  readonly goal: string;
  readonly roles: readonly ProjectManagerPlannerRole[];
}

export interface ProjectManagerPlannedTask {
  readonly ownerRole: string;
  readonly ownerDisplayName: string;
  readonly title: string;
  readonly description: string;
  readonly state: "todo";
}

export interface ProjectManagerPlan {
  readonly goal: string;
  readonly projectManagerRoleKey: string;
  readonly projectManagerDisplayName: string;
  readonly summary: string;
  readonly steps: readonly string[];
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

const DEFAULT_PLAN_STEPS = [
  "Capture the requested outcome and keep the first run in planned state.",
  "Split the work into specialist-owned tasks using the saved role responsibilities.",
  "Keep validation visible so execution can start with a clear handoff and review path.",
] as const;

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

function summarizeGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
}

function createTaskTitle(role: ProjectManagerPlannerRole, goal: string): string {
  if (isFrontendRole(role)) {
    return `Design and implement the user-facing flow for ${goal}.`;
  }

  if (isBackendRole(role)) {
    return `Implement the runtime and persistence support for ${goal}.`;
  }

  if (isReviewRole(role)) {
    return `Validate the delivered work for ${goal}.`;
  }

  return `Advance the ${role.displayName} slice for ${goal}.`;
}

function createTaskDescription(
  role: ProjectManagerPlannerRole,
  goal: string,
): string {
  return `${role.displayName} owns the "${goal}" slice that matches this responsibility: ${role.responsibility}`;
}

function createPlanSummary(
  goal: string,
  tasks: readonly ProjectManagerPlannedTask[],
): string {
  return `Create a first-pass delivery plan for "${goal}" with ${tasks.length} specialist task${tasks.length === 1 ? "" : "s"} before execution starts.`;
}

function createPlanMessage(input: {
  goal: string;
  projectManagerDisplayName: string;
  summary: string;
  steps: readonly string[];
  tasks: readonly ProjectManagerPlannedTask[];
}): string {
  const sections = [
    `${input.projectManagerDisplayName} plan for: ${input.goal}`,
    "",
    `Summary: ${input.summary}`,
    "",
    "Execution outline:",
    ...input.steps.map((step, index) => `${index + 1}. ${step}`),
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
    const goal = normalizeRequiredString(input.goal, "goal");
    const roles = input.roles.map(normalizeRole);
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

    const normalizedGoal = summarizeGoal(goal);
    const tasks = specialistRoles.map((role) => ({
      ownerRole: role.roleKey,
      ownerDisplayName: role.displayName,
      title: createTaskTitle(role, normalizedGoal),
      description: createTaskDescription(role, normalizedGoal),
      state: "todo" as const,
    }));
    const summary = createPlanSummary(normalizedGoal, tasks);
    const steps = [...DEFAULT_PLAN_STEPS];

    return {
      goal,
      projectManagerRoleKey: projectManagerRole.roleKey,
      projectManagerDisplayName: projectManagerRole.displayName,
      summary,
      steps,
      tasks,
      message: createPlanMessage({
        goal,
        projectManagerDisplayName: projectManagerRole.displayName,
        summary,
        steps,
        tasks,
      }),
    };
  }
}

export function createProjectManagerPlannerService(): ProjectManagerPlannerService {
  return new DefaultProjectManagerPlannerService();
}
