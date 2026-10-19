import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { prisma } from "./prisma.js";

/**
 * Abordarea aleasă pentru integrare: **funcțiile de serviciu apelate direct**,
 * cu un obiect `fastify`-like, nu `buildServer()`.
 *
 * Motivul e concret: `buildServer()` montează Bull Board și înregistrează cozi,
 * iar multe module creează `new Queue(...)` la import — ar cere Redis, ar lăsa
 * handle-uri deschise și ar face suita fragilă. Serviciile, în schimb, primesc
 * toate `fastify` ca prim argument și folosesc din el doar `prisma`,
 * `httpErrors` și `log` (vezi `GuardDeps` din src/lib/tenant-guard.ts).
 *
 * `httpErrors` NU e falsificat: vine din `@fastify/sensible` montat pe o
 * instanță Fastify minimală (fără rute, fără plugin-uri de rețea), deci
 * erorile aruncate au exact `statusCode`-urile pe care le-ar vedea un client.
 */

let app: FastifyInstance | null = null;

/** Instanța minimală care ne dă `httpErrors` reali. */
export async function sensibleApp(): Promise<FastifyInstance> {
  if (app) return app;
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  await instance.ready();
  app = instance;
  return instance;
}

export interface ServiceStub {
  prisma: typeof prisma;
  httpErrors: FastifyInstance["httpErrors"];
  log: { info: () => void; warn: () => void; error: () => void; debug: () => void; child: () => unknown };
}

/** Stub-ul pasat serviciilor ca prim argument (`fastify`). */
export async function serviceStub(): Promise<FastifyInstance> {
  const instance = await sensibleApp();
  const noop = () => {};
  const stub = {
    prisma,
    httpErrors: instance.httpErrors,
    log: { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => stub.log },
  };
  return stub as unknown as FastifyInstance;
}

export async function closeStub() {
  await app?.close();
  app = null;
}

/** Statusul HTTP al unei erori aruncate de un serviciu (httpErrors sau 402 „manual”). */
export function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null ? (err as { statusCode?: number }).statusCode : undefined;
}

/**
 * Rulează `fn` și întoarce `{ status, message }` erorii. Eșuează dacă `fn` NU
 * aruncă — altfel un test de izolare ar trece în silență când garda dispare.
 */
export async function expectReject(fn: () => Promise<unknown>): Promise<{ status?: number; message: string }> {
  try {
    await fn();
  } catch (err) {
    return { status: statusOf(err), message: err instanceof Error ? err.message : String(err) };
  }
  throw new Error("Apelul ar fi trebuit să arunce, dar a reușit");
}
