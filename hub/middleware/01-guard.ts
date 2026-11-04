import { defineMiddleware } from "void";
import { verifyUser, verifyAgent, tokenFrom, decodePayload } from "../lib/access";

// API は、Access でログインした本人（同じオリジン）か、許可した親エージェントのサービストークンからの呼び出しだけを通す
export default defineMiddleware(async (c, next) => {
  const url = new URL(c.req.url);
  if (!url.pathname.startsWith("/api/")) return next();
  const env = c.env as any;
  // 手元の vite dev で試すときだけ認証を飛ばす。.env は本番に送られず、ホスト名も localhost に限る
  if (env.DEV_NO_AUTH === "1" && url.hostname === "localhost") return next();
  // email のある JWT は本人、無ければサービストークン（親エージェント）として確かめる
  const token = tokenFrom(c.req.raw);
  const payload = token ? decodePayload(token)?.payload : null;
  const err = await (typeof payload?.email === "string" ? verifyUser(c.req.raw, env) : verifyAgent(c.req.raw, env)).catch((e) => `verify error: ${e}`);
  if (err) {
    console.warn(`access denied: ${err}`);
    return c.text("forbidden", 403);
  }
  const origin = c.req.header("origin");
  if (origin && origin !== url.origin) return c.text("forbidden origin", 403);
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return c.text("forbidden site", 403);
  if (c.req.method === "POST" && c.req.header("x-cc-inject") !== "1") return c.text("missing header", 403);
  return next();
});
