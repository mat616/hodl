import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { Connection } from "@solana/web3.js";
import { LOOP_MS, PORT, RPC, RPC_FALLBACK, SEND, ORACLE_MODE, loadKeeper, keeperKeyPath, rpcFetch } from "./config.js";
import { migrate } from "./db.js";
import { tick } from "./keeper.js";
import { registerRoutes } from "./routes.js";

async function main() {
  await migrate();
  const connection = new Connection(RPC, { commitment: "confirmed", fetch: rpcFetch });
  const keeper = loadKeeper();
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  });
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://solana-rpc.publicnode.com https://api.mainnet-beta.solana.com wss://api.mainnet-beta.solana.com; frame-ancestors 'none'",
    );
  });
  registerRoutes(app, connection);

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
  }

  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(
    {
      port: PORT,
      rpc: RPC,
      rpcFallback: Boolean(RPC_FALLBACK),
      send: SEND,
      oracle: ORACLE_MODE,
      keeper: keeper?.publicKey.toBase58() ?? null,
      key: keeperKeyPath(),
    },
    "farm stack up",
  );

  const run = async () => {
    try {
      const result = await tick(connection, keeper);
      app.log.info(result, "keeper tick");
    } catch (err) {
      app.log.error(err, "keeper tick failed");
    }
  };
  await run();
  setInterval(() => void run(), LOOP_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
