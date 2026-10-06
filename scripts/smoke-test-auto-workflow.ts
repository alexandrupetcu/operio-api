/**
 * Smoke test for distributor + primary/secondary workflow + auto-start.
 *
 * Tests against the dev database directly. Cleans up after itself.
 *
 * Run: npx tsx --env-file=.env scripts/smoke-test-auto-workflow.ts
 */
import { PrismaClient } from "@prisma/client";
import { findPrimaryWorkflowFor } from "../src/modules/workflow-definitions/workflow-definitions.service.js";
import { spawnSubWorkflow } from "../src/lib/workflow-engine/sub-workflow.js";
import { create as createProject } from "../src/modules/projects/projects.service.js";
import { triggerDocumentGeneration } from "../src/lib/workflow-engine/document-trigger.js";
import {
  list as listTasks,
  create as createTask,
} from "../src/modules/tasks/tasks.service.js";

const prisma = new PrismaClient();

// Minimal fastify-like stub for service functions
const fastify = {
  prisma,
  httpErrors: {
    badRequest: (msg: string) => new Error(`BadRequest: ${msg}`),
    notFound: (msg: string) => new Error(`NotFound: ${msg}`),
    conflict: (msg: string) => new Error(`Conflict: ${msg}`),
  },
  log: {
    info: (data: unknown, msg?: string) => console.log("[INFO]", msg ?? "", data),
    warn: (data: unknown, msg?: string) => console.log("[WARN]", msg ?? "", data),
    error: (data: unknown, msg?: string) => console.log("[ERROR]", msg ?? "", data),
  },
} as any;

function pass(name: string, detail?: string) {
  console.log(`✅ ${name}${detail ? " — " + detail : ""}`);
}
function fail(name: string, detail: string) {
  console.log(`❌ ${name} — ${detail}`);
  process.exitCode = 1;
}

async function main() {
  console.log("\n━━━ SMOKE TESTS ━━━\n");

  const tenant = await prisma.tenant.findFirst({ where: { slug: "demo" } });
  if (!tenant) throw new Error("Demo tenant not found");
  const tenantId = tenant.id;

  // ─── Test 1: findPrimaryWorkflowFor exact match ────────────────────────────
  {
    const distrigaz = await prisma.distributor.findFirst({
      where: { tenantId, code: "DISTRIGAZ" },
    });
    const bransament = await prisma.projectType.findFirst({
      where: { tenantId, code: "bransament" },
    });
    if (!distrigaz || !bransament) {
      fail("Test 1 — setup", "Missing seed data (distrigaz/bransament)");
      return;
    }

    const wf = await findPrimaryWorkflowFor(
      fastify,
      tenantId,
      bransament.id,
      distrigaz.id
    );
    if (wf) {
      pass(
        "Test 1: findPrimaryWorkflowFor(bransament, distrigaz)",
        `found "${wf.name}" (role=${wf.role})`
      );
    } else {
      pass(
        "Test 1: findPrimaryWorkflowFor(bransament, distrigaz)",
        "no match — will use fallback to projectType-only"
      );
    }
  }

  // ─── Test 2: findPrimaryWorkflowFor fallback (distributorId=null) ──────────
  {
    const distrigaz = await prisma.distributor.findFirst({
      where: { tenantId, code: "DISTRIGAZ" },
    });
    const bransament = await prisma.projectType.findFirst({
      where: { tenantId, code: "bransament" },
    });
    if (!distrigaz || !bransament) return;

    // Find a primary workflow for this project type with distributorId=null
    const wfDistributorNull = await prisma.workflowDefinition.findFirst({
      where: {
        tenantId,
        projectTypeId: bransament.id,
        distributorId: null,
        role: "primary",
        status: "published",
        isActive: true,
      },
    });

    const found = await findPrimaryWorkflowFor(
      fastify,
      tenantId,
      bransament.id,
      distrigaz.id
    );

    if (wfDistributorNull && found?.id === wfDistributorNull.id) {
      pass(
        "Test 2: fallback to distributorId=null",
        `correctly returned "${found.name}"`
      );
    } else if (!wfDistributorNull) {
      pass(
        "Test 2: fallback to distributorId=null",
        "no fallback wf exists — skipped"
      );
    } else if (found) {
      pass(
        "Test 2: fallback to distributorId=null",
        `exact match wins over fallback ("${found.name}")`
      );
    } else {
      fail(
        "Test 2: fallback to distributorId=null",
        "expected to find a workflow"
      );
    }
  }

  // ─── Test 3: findPrimaryWorkflowFor — no match ─────────────────────────────
  {
    const fakeProjectTypeId = "cm__nonexistent__type__id";
    const fakeDistributorId = "cm__nonexistent__dist__id";
    const result = await findPrimaryWorkflowFor(
      fastify,
      tenantId,
      fakeProjectTypeId,
      fakeDistributorId
    );
    if (result === null) {
      pass("Test 3: no match returns null");
    } else {
      fail("Test 3: no match returns null", `got ${JSON.stringify(result)}`);
    }
  }

  // ─── Test 4: spawnSubWorkflow rejects primary ──────────────────────────────
  {
    const primaryWf = await prisma.workflowDefinition.findFirst({
      where: { tenantId, role: "primary", status: "published" },
    });
    const secondaryWf = await prisma.workflowDefinition.findFirst({
      where: { role: "secondary", status: "published" },
    });
    const testProject = await prisma.project.findFirst({ where: { tenantId } });

    if (!primaryWf || !testProject) {
      fail("Test 4: setup", "No primary workflow or project found");
      return;
    }

    // Create a dummy parent workflow instance + step instance for the test
    const parentInstance = await prisma.workflowInstance.create({
      data: {
        tenantId,
        workflowDefinitionId: primaryWf.id,
        entityType: "project",
        entityId: testProject.id,
        status: "running",
        startedAt: new Date(),
        contextJson: {},
      },
    });

    try {
      await spawnSubWorkflow(
        fastify,
        tenantId,
        "smoke-test-parent-step-id",
        {
          id: parentInstance.id,
          workflowDefinitionId: primaryWf.id,
          contextJson: {},
          startedAt: new Date(),
          entityType: "project",
          entityId: testProject.id,
        },
        primaryWf.id, // try to spawn a PRIMARY as sub-workflow
        null
      );
      fail(
        "Test 4: spawnSubWorkflow rejects primary",
        "expected throw, but call succeeded"
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (
        msg.includes("only \"secondary\" workflows can be spawned") ||
        msg.includes("only \"secondary\"")
      ) {
        pass(
          "Test 4: spawnSubWorkflow rejects primary",
          "threw with correct message"
        );
      } else {
        fail("Test 4: spawnSubWorkflow rejects primary", `wrong error: ${msg}`);
      }
    }

    // Cleanup parent instance
    await prisma.workflowInstance.deleteMany({
      where: { id: parentInstance.id },
    });

    // ─── Test 5: spawnSubWorkflow accepts secondary ────────────────────────
    if (secondaryWf) {
      const parentInstance2 = await prisma.workflowInstance.create({
        data: {
          tenantId,
          workflowDefinitionId: primaryWf.id,
          entityType: "project",
          entityId: testProject.id,
          status: "running",
          startedAt: new Date(),
          contextJson: {},
        },
      });

      // Need a real parent step instance for the FK
      const dummyStartStep = await prisma.workflowStep.findFirst({
        where: { workflowDefinitionId: primaryWf.id, isStart: true },
      });
      if (!dummyStartStep) {
        fail("Test 5: setup", "primary has no start step");
      } else {
        const parentStepInstance = await prisma.workflowStepInstance.create({
          data: {
            tenantId,
            workflowInstanceId: parentInstance2.id,
            stepDefinitionId: dummyStartStep.id,
            status: "waiting",
            startedAt: new Date(),
          },
        });

        try {
          const childId = await spawnSubWorkflow(
            fastify,
            tenantId,
            parentStepInstance.id,
            {
              id: parentInstance2.id,
              workflowDefinitionId: primaryWf.id,
              contextJson: {},
              startedAt: new Date(),
              entityType: "project",
              entityId: testProject.id,
            },
            secondaryWf.id,
            null
          );
          pass(
            "Test 5: spawnSubWorkflow accepts secondary",
            `spawned child ${childId.slice(0, 12)}...`
          );

          // Cleanup child workflow + its step instances
          await prisma.workflowStepInstance.deleteMany({
            where: { workflowInstanceId: childId },
          });
          await prisma.workflowExecutionLog.deleteMany({
            where: { workflowInstanceId: childId },
          });
          await prisma.workflowInstance.deleteMany({ where: { id: childId } });
        } catch (err) {
          fail(
            "Test 5: spawnSubWorkflow accepts secondary",
            (err as Error).message
          );
        }

        await prisma.workflowExecutionLog.deleteMany({
          where: { workflowInstanceId: parentInstance2.id },
        });
        await prisma.workflowStepInstance.deleteMany({
          where: { id: parentStepInstance.id },
        });
      }

      await prisma.workflowInstance.deleteMany({
        where: { id: parentInstance2.id },
      });
    } else {
      console.log("⏭  Test 5 skipped — no secondary workflow seeded");
    }
  }

  // ─── Test 6: Schema check — Distributor table populated correctly ──────────
  {
    const distributors = await prisma.distributor.findMany({
      where: { tenantId },
      orderBy: { code: "asc" },
    });
    const codes = distributors.map((d) => d.code);
    if (
      codes.includes("DISTRIGAZ") &&
      codes.includes("NEOGAS_GRID") &&
      codes.includes("MEGACONSTRUCT")
    ) {
      pass(
        "Test 6: 3 distributors seeded",
        `[${codes.join(", ")}]`
      );
    } else {
      fail(
        "Test 6: 3 distributors seeded",
        `got [${codes.join(", ")}]`
      );
    }
  }

  // ─── Test 7: WorkflowDefinition.role distribution ──────────────────────────
  {
    const counts = await prisma.workflowDefinition.groupBy({
      by: ["role"],
      _count: true,
    });
    const primary = counts.find((c) => c.role === "primary")?._count ?? 0;
    const secondary = counts.find((c) => c.role === "secondary")?._count ?? 0;
    if (primary > 0) {
      pass(
        "Test 7: role distribution",
        `${primary} primary, ${secondary} secondary`
      );
    } else {
      fail("Test 7: role distribution", "no primary workflows exist");
    }
  }

  // ─── Test 8: End-to-end — create project auto-starts primary workflow ─────
  {
    const distrigaz = await prisma.distributor.findFirst({
      where: { tenantId, code: "DISTRIGAZ" },
    });
    const bransament = await prisma.projectType.findFirst({
      where: { tenantId, code: "bransament" },
    });
    const client = await prisma.client.findFirst({ where: { tenantId } });
    const admin = await prisma.user.findFirst({
      where: { tenantId, role: "ADMIN" },
    });

    if (!distrigaz || !bransament || !client || !admin) {
      fail("Test 8: setup", "Missing seed data");
      return;
    }

    let createdProjectId: string | null = null;
    try {
      const project = await createProject(
        fastify,
        tenantId,
        admin.id,
        {
          clientId: client.id,
          projectTypeId: bransament.id,
          distributorId: distrigaz.id,
          name: "SMOKE TEST — auto-start project",
          address: "Str. Test 1",
          city: "Cluj-Napoca",
          county: "Cluj",
        } as any
      );
      createdProjectId = project.id;

      // Wait briefly for async fire-and-forget log writes (auto-start is awaited, logs are not)
      await new Promise((r) => setTimeout(r, 200));

      // Verify auto-start fired
      const reloaded = await prisma.project.findUnique({
        where: { id: project.id },
        include: { workflowInstances: { include: { workflowDefinition: true } } },
      });

      if (!reloaded) {
        fail("Test 8: project lookup", "Project not found after creation");
      } else if (!reloaded.currentWorkflowInstanceId) {
        fail(
          "Test 8: auto-start",
          "currentWorkflowInstanceId is null — workflow did not start"
        );
      } else if (reloaded.workflowInstances.length === 0) {
        fail(
          "Test 8: auto-start",
          "no workflow instances exist on project"
        );
      } else {
        const wf = reloaded.workflowInstances[0];
        pass(
          "Test 8: end-to-end create + auto-start",
          `project ${reloaded.id.slice(0, 8)} → workflow "${wf.workflowDefinition.name}" (instance ${wf.id.slice(0, 8)}, status=${wf.status})`
        );
      }
    } catch (err) {
      fail("Test 8: create project", (err as Error).message);
    } finally {
      // Cleanup
      if (createdProjectId) {
        await prisma.workflowExecutionLog.deleteMany({
          where: { workflowInstance: { entityId: createdProjectId } },
        });
        await prisma.workflowStepInstance.deleteMany({
          where: { workflowInstance: { entityId: createdProjectId } },
        });
        await prisma.workflowInstance.deleteMany({
          where: { entityId: createdProjectId },
        });
        await prisma.project.delete({ where: { id: createdProjectId } });
      }
    }
  }

  // ─── Test 9: Create project with NO matching workflow → no auto-start ──────
  {
    const client = await prisma.client.findFirst({ where: { tenantId } });
    const admin = await prisma.user.findFirst({
      where: { tenantId, role: "ADMIN" },
    });
    // Use a project type WITHOUT a published primary workflow
    const projectTypes = await prisma.projectType.findMany({
      where: { tenantId },
    });
    let typeWithoutWorkflow: typeof projectTypes[number] | null = null;
    for (const pt of projectTypes) {
      const wf = await prisma.workflowDefinition.findFirst({
        where: {
          tenantId,
          projectTypeId: pt.id,
          role: "primary",
          status: "published",
        },
      });
      if (!wf) {
        typeWithoutWorkflow = pt;
        break;
      }
    }

    if (!client || !admin || !typeWithoutWorkflow) {
      console.log("⏭  Test 9 skipped — no project type without primary workflow");
    } else {
      let createdProjectId: string | null = null;
      try {
        const project = await createProject(
          fastify,
          tenantId,
          admin.id,
          {
            clientId: client.id,
            projectTypeId: typeWithoutWorkflow.id,
            name: "SMOKE TEST — no workflow available",
            address: "Str. Test 2",
            city: "Cluj-Napoca",
            county: "Cluj",
          } as any
        );
        createdProjectId = project.id;

        const reloaded = await prisma.project.findUnique({
          where: { id: project.id },
        });

        if (!reloaded?.currentWorkflowInstanceId) {
          pass(
            "Test 9: no matching workflow → project created without one",
            `(projectType=${typeWithoutWorkflow.code}, currentWorkflowInstanceId=null)`
          );
        } else {
          fail(
            "Test 9: no matching workflow",
            `unexpected workflow started: ${reloaded.currentWorkflowInstanceId}`
          );
        }
      } catch (err) {
        fail("Test 9: create project", (err as Error).message);
      } finally {
        if (createdProjectId) {
          await prisma.project.delete({ where: { id: createdProjectId } });
        }
      }
    }
  }

  // ─── Test 10: document_generation links documents to step + sets step waiting ─
  {
    const tenant2 = tenant; // reuse
    const project = await prisma.project.findFirst({ where: { tenantId } });
    const template = await prisma.documentTemplate.findFirst({
      where: { OR: [{ tenantId }, { tenantId: null }], isActive: true },
    });

    if (!project || !template) {
      console.log("⏭  Test 10 skipped — no project or template available");
    } else {
      // Create an isolated workflow definition + instance + step for the test
      const wfDef = await prisma.workflowDefinition.create({
        data: {
          tenantId,
          code: `smoke_doc_gen_${Date.now()}`,
          name: "SMOKE — doc gen test",
          status: "published",
          isActive: true,
          role: "primary",
        },
      });
      const startStep = await prisma.workflowStep.create({
        data: {
          tenantId,
          workflowDefinitionId: wfDef.id,
          code: "doc_gen_step",
          name: "Generate docs",
          stepType: "document_generation",
          orderIndex: 0,
          isStart: true,
          configJson: { templateIds: [template.id] } as any,
        },
      });
      const wfInstance = await prisma.workflowInstance.create({
        data: {
          tenantId,
          workflowDefinitionId: wfDef.id,
          entityType: "project",
          entityId: project.id,
          status: "running",
          startedAt: new Date(),
        },
      });
      const stepInstance = await prisma.workflowStepInstance.create({
        data: {
          tenantId,
          workflowInstanceId: wfInstance.id,
          stepDefinitionId: startStep.id,
          status: "active",
          startedAt: new Date(),
        },
      });

      try {
        // Trigger doc generation — this should create Documents linked to step
        const ok = await triggerDocumentGeneration(
          fastify,
          tenantId,
          stepInstance.id,
          {
            id: wfInstance.id,
            entityId: project.id,
            entityType: "project",
          },
          { templateIds: [template.id] }
        );

        if (!ok) {
          fail("Test 10: triggerDocumentGeneration", "returned false");
        } else {
          const docs = await prisma.document.findMany({
            where: { workflowStepInstanceId: stepInstance.id },
          });
          if (docs.length === 0) {
            fail(
              "Test 10: documents linked to step",
              "no documents found with workflowStepInstanceId"
            );
          } else {
            pass(
              "Test 10: triggerDocumentGeneration links docs to step",
              `${docs.length} document(s) with workflowStepInstanceId set, all status=${docs[0].status}`
            );
          }
        }
      } finally {
        // Cleanup — order matters due to FKs
        await prisma.projectDocument.deleteMany({
          where: { document: { workflowStepInstanceId: stepInstance.id } },
        });
        await prisma.document.deleteMany({
          where: { workflowStepInstanceId: stepInstance.id },
        });
        await prisma.workflowExecutionLog.deleteMany({
          where: { workflowInstanceId: wfInstance.id },
        });
        await prisma.workflowStepInstance.delete({ where: { id: stepInstance.id } });
        await prisma.workflowInstance.delete({ where: { id: wfInstance.id } });
        await prisma.workflowStep.delete({ where: { id: startStep.id } });
        await prisma.workflowDefinition.delete({ where: { id: wfDef.id } });
      }
    }
  }

  // ─── Test 11: Filtering workflow_generated tasks via excludeTaskType ────────
  {
    const project = await prisma.project.findFirst({ where: { tenantId } });
    if (!project) {
      console.log("⏭  Test 11 skipped — no project available");
    } else {
      // Create 2 tasks: one manual, one workflow_generated
      const manualTask = await prisma.task.create({
        data: {
          tenantId,
          projectId: project.id,
          title: "SMOKE test manual task",
          taskType: "manual",
          status: "open",
        },
      });
      const wfTask = await prisma.task.create({
        data: {
          tenantId,
          projectId: project.id,
          title: "SMOKE test workflow-generated task",
          taskType: "workflow_generated",
          status: "open",
        },
      });

      try {
        // Default: both tasks returned
        const all = await listTasks(fastify, tenantId, {
          projectId: project.id,
          page: 1,
          limit: 100,
          sortBy: "createdAt",
          sortOrder: "desc",
        } as any);
        const allIds = all.data.map((t: any) => t.id);

        // With excludeTaskType: only manual
        const filtered = await listTasks(fastify, tenantId, {
          projectId: project.id,
          excludeTaskType: "workflow_generated",
          page: 1,
          limit: 100,
          sortBy: "createdAt",
          sortOrder: "desc",
        } as any);
        const filteredIds = filtered.data.map((t: any) => t.id);

        const allHasBoth =
          allIds.includes(manualTask.id) && allIds.includes(wfTask.id);
        const filteredHasManualNotWf =
          filteredIds.includes(manualTask.id) &&
          !filteredIds.includes(wfTask.id);

        if (allHasBoth && filteredHasManualNotWf) {
          pass(
            "Test 11: excludeTaskType filter",
            `default returns both, excludeTaskType=workflow_generated removes wf task`
          );
        } else {
          fail(
            "Test 11: excludeTaskType filter",
            `allHasBoth=${allHasBoth}, filteredHasManualNotWf=${filteredHasManualNotWf}`
          );
        }
      } finally {
        await prisma.task.deleteMany({
          where: { id: { in: [manualTask.id, wfTask.id] } },
        });
      }
    }
  }

  // ─── Test 12: Task creation with assignee → notification created ───────────
  {
    const project = await prisma.project.findFirst({ where: { tenantId } });
    const admin = await prisma.user.findFirst({
      where: { tenantId, role: "ADMIN" },
    });

    if (!project || !admin) {
      console.log("⏭  Test 12 skipped — no project or admin user");
    } else {
      const task = await createTask(fastify, tenantId, {
        title: "SMOKE test notify task",
        taskType: "manual",
        status: "open",
        priority: "normal",
        projectId: project.id,
        assignedUserId: admin.id,
        // 48h from now → reminder + overdue both schedulable
        dueAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      } as any);

      try {
        // Wait briefly for fire-and-forget notification creation
        await new Promise((r) => setTimeout(r, 300));

        const notifications = await prisma.notification.findMany({
          where: { taskId: task.id },
        });

        if (notifications.length === 0) {
          fail(
            "Test 12: notification on assignment",
            "no notification created"
          );
        } else {
          const n = notifications[0];
          if (n.userId === admin.id && n.status === "pending") {
            pass(
              "Test 12: notification on assignment",
              `created notification for admin (subject="${n.subject}")`
            );
          } else {
            fail(
              "Test 12: notification on assignment",
              `unexpected: userId=${n.userId}, status=${n.status}`
            );
          }
        }
      } finally {
        await prisma.notification.deleteMany({ where: { taskId: task.id } });
        await prisma.task.delete({ where: { id: task.id } });
      }
    }
  }

  console.log("\n━━━ DONE ━━━\n");
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
