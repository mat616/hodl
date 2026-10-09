import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer; process?: { env: Record<string, string> } };
g.Buffer = Buffer;
g.process = g.process ?? { env: {} };
