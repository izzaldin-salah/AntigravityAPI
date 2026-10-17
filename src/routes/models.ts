import type { FastifyPluginAsync } from "fastify";
import { mapProviderErrorToHttp } from "../core/errors";
import type { OpenAIModelListResponse } from "../types/openai";
import type { AIProvider } from "../types/provider";

export interface ModelsRouteOptions {
  provider: AIProvider;
}

export const modelsRoutes: FastifyPluginAsync<ModelsRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.get("/v1/models", async (_req, reply) => {
    try {
      const models = await opts.provider.listModels();
      const response: OpenAIModelListResponse = {
        object: "list",
        data: models,
      };
      return reply.status(200).send(response);
    } catch (err) {
      const { status, body } = mapProviderErrorToHttp(err);
      return reply.status(status).send(body);
    }
  });
};
