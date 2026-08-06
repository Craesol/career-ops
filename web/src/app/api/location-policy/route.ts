import { locationPolicyLists } from "@/lib/core/location-filter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The user's standing location policy (portals.yml location_filter), served to
// the client so AI-search streams and rehydrated result snapshots can honor it
// — the server-side paths (runDiscovery, whats-new) already enforce it.
export async function GET() {
  return Response.json(locationPolicyLists());
}
