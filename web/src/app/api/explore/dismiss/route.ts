import { dismissOffers } from "@/lib/core/pipeline";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Remove" on a fresh-match card: append-only skip record via the core's own
// scan-history writer — the offer stops surfacing in /api/whats-new and future
// scans dedup it. Never deletes history, never touches the tracker.
export async function POST(req: Request) {
  let body: { offers?: DiscoveredOffer[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const offers = Array.isArray(body.offers) ? body.offers : [];
  if (offers.length === 0) return Response.json({ error: "offers required" }, { status: 400 });
  const result = await dismissOffers(offers);
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
