import type { FastifyPluginAsync } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { registerAuthRoutes } from './auth.js';
import { registerPanelRoutes } from './panels.js';
import type { ConsoleDeps } from './context.js';

export type { ConsoleDeps } from './context.js';

/**
 * The admin console as an encapsulated Fastify plugin: cookies + urlencoded form
 * bodies + all console routes (auth, panels). Mount under the main server.
 */
export function createConsole(deps: ConsoleDeps): FastifyPluginAsync {
  return async (app) => {
    await app.register(fastifyCookie);
    await app.register(fastifyFormbody);
    registerAuthRoutes(app, deps);
    registerPanelRoutes(app, deps);
  };
}
