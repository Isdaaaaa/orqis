import { describe, expect, it } from "vitest";

import {
  createProjectManagerPlannerService,
  ProjectManagerPlannerValidationError,
} from "../src/index.ts";

describe("project manager planner service", () => {
  it("creates a first-pass plan and role-owned task list from saved agent roles", () => {
    const service = createProjectManagerPlannerService();

    const plan = service.planGoal({
      goal: "Implement persistent task approvals for the web runtime.",
      roles: [
        {
          roleKey: "project_manager",
          displayName: "Project Manager",
          responsibility: "Plans work and coordinates approvals.",
        },
        {
          roleKey: "frontend_agent",
          displayName: "Frontend Agent",
          responsibility: "Owns UI structure, styling, and interaction details.",
        },
        {
          roleKey: "backend_agent",
          displayName: "Backend Agent",
          responsibility:
            "Owns runtime behavior, persistence changes, and API contracts.",
        },
        {
          roleKey: "reviewer",
          displayName: "Reviewer",
          responsibility: "Owns validation and regression review.",
        },
      ],
    });

    expect(plan.projectManagerRoleKey).toBe("project_manager");
    expect(plan.workflowCommand).toBe("plan");
    expect(plan.summary).toContain("persistent task approvals");
    expect(plan.statusUpdate).toContain("Planning workflow is complete");
    expect(plan.steps).toHaveLength(3);
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks.map((task) => task.ownerRole)).toEqual([
      "frontend_agent",
      "backend_agent",
      "reviewer",
    ]);
    expect(plan.tasks.every((task) => task.state === "todo")).toBe(true);
    expect(plan.tasks[0]?.title).toContain("user-facing flow");
    expect(plan.tasks[1]?.title).toContain("runtime and persistence support");
    expect(plan.tasks[2]?.title).toContain("Validate the delivered work");
    expect(plan.message).toContain("Project Manager plan for:");
    expect(plan.message).toContain("Workflow command: plan");
    expect(plan.message).toContain("Status update:");
    expect(plan.message).toContain("Frontend Agent:");
    expect(plan.message).toContain("Backend Agent:");
    expect(plan.message).toContain("Reviewer:");
  });

  it("falls back to a generic task title for non-specialized role keys", () => {
    const service = createProjectManagerPlannerService();

    const plan = service.planGoal({
      goal: "Ship the release checklist",
      roles: [
        {
          roleKey: "project_manager",
          displayName: "Project Manager",
          responsibility: "Plans work and coordinates approvals.",
        },
        {
          roleKey: "docs_agent",
          displayName: "Docs Agent",
          responsibility: "Owns docs updates and release notes.",
        },
      ],
    });

    expect(plan.tasks).toEqual([
      expect.objectContaining({
        ownerRole: "docs_agent",
        title: "Advance the Docs Agent slice for Ship the release checklist.",
      }),
    ]);
  });

  it("rejects planner input without a goal, project manager role, or specialist role", () => {
    const service = createProjectManagerPlannerService();

    expect(() =>
      service.planGoal({
        goal: "   ",
        roles: [],
      }),
    ).toThrowError(
      new ProjectManagerPlannerValidationError(
        "goal must be a non-empty string.",
      ),
    );

    expect(() =>
      service.planGoal({
        goal: "Ship approvals",
        roles: [
          {
            roleKey: "backend_agent",
            displayName: "Backend Agent",
            responsibility: "Owns runtime behavior and persistence.",
          },
        ],
      }),
    ).toThrowError(
      new ProjectManagerPlannerValidationError(
        'roles must include the reserved "project_manager" role before planning can start.',
      ),
    );

    expect(() =>
      service.planGoal({
        goal: "Ship approvals",
        roles: [
          {
            roleKey: "project_manager",
            displayName: "Project Manager",
            responsibility: "Plans work and coordinates approvals.",
          },
        ],
      }),
    ).toThrowError(
      new ProjectManagerPlannerValidationError(
        "roles must include at least one specialist role in addition to the Project Manager.",
      ),
    );
  });

  it("requires the reserved project_manager role key instead of inferring PM from display name", () => {
    const service = createProjectManagerPlannerService();

    expect(() =>
      service.planGoal({
        goal: "Ship approvals",
        roles: [
          {
            roleKey: "pm",
            displayName: "Project Manager",
            responsibility: "Plans work and coordinates approvals.",
          },
          {
            roleKey: "backend_agent",
            displayName: "Backend Agent",
            responsibility: "Owns runtime behavior and persistence.",
          },
        ],
      }),
    ).toThrowError(
      new ProjectManagerPlannerValidationError(
        'roles must include the reserved "project_manager" role before planning can start.',
      ),
    );
  });

  it("routes implement/review/integrate workflow commands to phase-specific specialists", () => {
    const service = createProjectManagerPlannerService();

    const implementPlan = service.planGoal({
      goal: "implement: close the approval workflow",
      roles: [
        {
          roleKey: "project_manager",
          displayName: "Project Manager",
          responsibility: "Plans work and coordinates approvals.",
        },
        {
          roleKey: "frontend_agent",
          displayName: "Frontend Agent",
          responsibility: "Owns UI structure and interaction details.",
        },
        {
          roleKey: "backend_agent",
          displayName: "Backend Agent",
          responsibility: "Owns runtime behavior and persistence.",
        },
        {
          roleKey: "reviewer",
          displayName: "Reviewer",
          responsibility: "Owns validation and release readiness checks.",
        },
      ],
    });
    expect(implementPlan.workflowCommand).toBe("implement");
    expect(implementPlan.summary).toContain("implementation workflow");
    expect(implementPlan.tasks.map((task) => task.ownerRole)).toEqual([
      "frontend_agent",
      "backend_agent",
    ]);
    expect(implementPlan.message).toContain("Workflow command: implement");
    expect(implementPlan.message).toContain("Status update:");

    const reviewPlan = service.planGoal({
      goal: "review: close the approval workflow",
      roles: [
        {
          roleKey: "project_manager",
          displayName: "Project Manager",
          responsibility: "Plans work and coordinates approvals.",
        },
        {
          roleKey: "frontend_agent",
          displayName: "Frontend Agent",
          responsibility: "Owns UI structure and interaction details.",
        },
        {
          roleKey: "backend_agent",
          displayName: "Backend Agent",
          responsibility: "Owns runtime behavior and persistence.",
        },
        {
          roleKey: "reviewer",
          displayName: "Reviewer",
          responsibility: "Owns validation and release readiness checks.",
        },
      ],
    });
    expect(reviewPlan.workflowCommand).toBe("review");
    expect(reviewPlan.summary).toContain("review workflow");
    expect(reviewPlan.tasks.map((task) => task.ownerRole)).toEqual(["reviewer"]);
    expect(reviewPlan.tasks[0]?.title).toContain("Review and validate");
    expect(reviewPlan.message).toContain("Workflow command: review");

    const integratePlan = service.planGoal({
      goal: "integrate: close the approval workflow",
      roles: [
        {
          roleKey: "project_manager",
          displayName: "Project Manager",
          responsibility: "Plans work and coordinates approvals.",
        },
        {
          roleKey: "frontend_agent",
          displayName: "Frontend Agent",
          responsibility: "Owns UI structure and interaction details.",
        },
        {
          roleKey: "backend_agent",
          displayName: "Backend Agent",
          responsibility: "Owns runtime behavior and persistence.",
        },
        {
          roleKey: "reviewer",
          displayName: "Reviewer",
          responsibility: "Owns validation and release readiness checks.",
        },
      ],
    });
    expect(integratePlan.workflowCommand).toBe("integrate");
    expect(integratePlan.summary).toContain("integration workflow");
    expect(integratePlan.tasks.map((task) => task.ownerRole)).toEqual([
      "backend_agent",
    ]);
    expect(integratePlan.tasks[0]?.title).toContain("Integrate and stabilize");
    expect(integratePlan.message).toContain("Workflow command: integrate");
  });

  it("rejects review workflow command when no review role is available", () => {
    const service = createProjectManagerPlannerService();

    expect(() =>
      service.planGoal({
        goal: "review: validate the release candidate",
        roles: [
          {
            roleKey: "project_manager",
            displayName: "Project Manager",
            responsibility: "Plans work and coordinates approvals.",
          },
          {
            roleKey: "backend_agent",
            displayName: "Backend Agent",
            responsibility: "Owns runtime behavior and persistence.",
          },
        ],
      }),
    ).toThrowError(
      new ProjectManagerPlannerValidationError(
        'roles must include at least one review specialist role before running "review:" commands.',
      ),
    );
  });

  it("rejects recognized workflow commands without an objective payload", () => {
    const service = createProjectManagerPlannerService();

    expect(() =>
      service.planGoal({
        goal: "implement:",
        roles: [
          {
            roleKey: "project_manager",
            displayName: "Project Manager",
            responsibility: "Plans work and coordinates approvals.",
          },
          {
            roleKey: "backend_agent",
            displayName: "Backend Agent",
            responsibility: "Owns runtime behavior and persistence.",
          },
        ],
      }),
    ).toThrowError(
      new ProjectManagerPlannerValidationError(
        'goal command "implement" must include a non-empty objective after ":".',
      ),
    );
  });
});
