import { getStore } from "@netlify/blobs";
import { handle, type KV } from "../gallery/router";

/** Netlify Blobs behind the router's tiny KV interface (strong consistency: admin sees writes at once). */
function blobsKv(): KV {
  const store = getStore({ name: "gallery", consistency: "strong" });
  return {
    async getJSON(key) {
      return (await store.get(key, { type: "json" })) ?? null;
    },
    async getBytes(key) {
      const buf = await store.get(key, { type: "arrayBuffer" });
      return buf ? new Uint8Array(buf) : null;
    },
    async setJSON(key, value) {
      await store.setJSON(key, value);
    },
    async setBytes(key, value) {
      await store.set(key, value.slice().buffer);
    },
    async delete(key) {
      await store.delete(key);
    },
    async list(prefix) {
      const { blobs } = await store.list({ prefix });
      return blobs.map((b) => b.key);
    }
  };
}

export default async (req: Request, context: { ip?: string }) =>
  handle(req, {
    kv: blobsKv(),
    ip: context.ip ?? req.headers.get("x-nf-client-connection-ip") ?? "unknown",
    adminPassword: process.env.ADMIN_PASSWORD || undefined
  });

export const config = { path: ["/api/gallery", "/api/gallery/*"] };
