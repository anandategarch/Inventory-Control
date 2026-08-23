import { NextRequest, NextResponse } from "next/server";
import { validateQuery, statusQuerySchema } from '@/lib/validation';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  // Sprint 1: Zod input validation (no params expected)
  const validation = validateQuery(statusQuerySchema, url.searchParams);
  if (!validation.success) {
    return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
  }

  return NextResponse.json({ message: "Hello, world!" });
}