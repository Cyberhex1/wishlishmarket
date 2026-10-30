// Cloudflare Pages Function: serves /api/* on the Market site's own origin.
import { handle } from "../../app.js";

export const onRequest = ({ request, env }) => handle(request, env);
