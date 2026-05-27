import { NextResponse, type NextRequest } from "next/server";
import { fetchJobSpyJobs } from "@/lib/jobs/jobspy";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query")?.trim() ?? "";
  if (!query) {
    return NextResponse.json({ data: [] });
  }

  const data = await fetchJobSpyJobs(query);
  return NextResponse.json({ data });
}
