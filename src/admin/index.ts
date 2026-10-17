import type { FastifyInstance } from "fastify";
import type { AdminDashboardDeps } from "./routes";
import { createAdminRoutes } from "./routes";

export type { AdminDashboardDeps } from "./routes";
export { renderDisabledPage } from "./pages";

export async function registerAdminDashboard(
  app: FastifyInstance,
  deps: AdminDashboardDeps,
): Promise<void> {
  createAdminRoutes(app, deps);
}
