import { handleGifs } from "../gifs/klipy";

// KLIPY_API_KEY: set in Netlify (Site configuration → Environment variables). Without it the
// endpoint answers 503 and the app falls back to its Tenor search.
export default async (req: Request) => handleGifs(req, { apiKey: process.env.KLIPY_API_KEY || undefined });

export const config = { path: "/api/gifs" };
