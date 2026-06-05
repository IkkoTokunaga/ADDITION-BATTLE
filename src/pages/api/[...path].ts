import type { APIContext } from 'astro';
import { app } from '../../lib/api-app';

export const prerender = false;

export const ALL = (context: APIContext) => app.fetch(context.request);
