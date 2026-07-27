import { dismissOffers } from "@/lib/core/pipeline";
import { closePendingByUrl } from "@/lib/core/close-pending";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Remove" on a fresh-match card. Two writes, both required:
//   1. an append-only `skipped` row in scan-history, so the offer stops
//      surfacing in /api/whats-new and future scans dedup it, and
//   2. closing the matching PENDING pipeline.md entry — without this a card
//      removed from Fresh matches kept sitting in the Pipeline inbox, which is
//      what the user actually sees as "it wasn't removed".
// Neither deletes anything; the tracker is untouched.
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

  const closed = closePendingByUrl(offers.map((o) => o.url), "removed from fresh matches");
  return Response.json({ ...result, closedFromPipeline: closed });
}
