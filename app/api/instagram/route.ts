import { NextRequest, NextResponse } from "next/server";
import {
  ProviderError,
  fetchInstagramMedia,
  parseTarget,
} from "@/lib/instagram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function fail(error: string, status: number) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url")?.trim();

  if (!raw) {
    return fail("Masukkan tautan Instagram terlebih dahulu.", 400);
  }

  const target = parseTarget(raw);

  if (!target) {
    return fail(
      "Tautan Instagram tidak valid. Gunakan tautan Reel atau post Instagram.",
      400
    );
  }

  try {
    const data = await fetchInstagramMedia(target);

    return NextResponse.json(
      { ok: true, data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      return fail(error.message, error.status);
    }

    return fail(
      error instanceof Error ? error.message : "Gagal memproses media.",
      500
    );
  }
}
