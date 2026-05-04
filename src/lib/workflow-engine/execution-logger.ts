import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";

/**
 * Insert a row into WorkflowExecutionLog.
 *
 * If the fastify instance has a `_logAccumulator` property (set during transactions),
 * the log entry is deferred and flushed in a single batch at the end of the transaction.
 */
export async function logEvent(
  fastify: FastifyInstance,
  tenantId: string,
  workflowInstanceId: string,
  stepInstanceId: string | null,
  eventType: string,
  payload?: unknown
): Promise<void> {
  const data: Prisma.WorkflowExecutionLogUncheckedCreateInput = {
    tenantId,
    workflowInstanceId,
    stepInstanceId: stepInstanceId ?? undefined,
    eventType,
    payloadJson: payload !== undefined
      ? (payload as Prisma.InputJsonValue)
      : undefined,
  };

  // If an accumulator exists, defer the insert for batch flush
  const accumulator = (fastify as any)._logAccumulator as
    | Prisma.WorkflowExecutionLogUncheckedCreateInput[]
    | undefined;
  if (accumulator) {
    accumulator.push(data);
    return;
  }

  await fastify.prisma.workflowExecutionLog.create({ data });
}

/**
 * Flush all accumulated log entries in a single batch insert.
 * Call this at the end of a transaction to commit all deferred logs.
 */
export async function flushLogs(
  fastify: FastifyInstance
): Promise<void> {
  const accumulator = (fastify as any)._logAccumulator as
    | Prisma.WorkflowExecutionLogUncheckedCreateInput[]
    | undefined;
  if (!accumulator || accumulator.length === 0) return;
  await fastify.prisma.workflowExecutionLog.createMany({ data: accumulator });
  accumulator.length = 0; // Clear after flush
}
