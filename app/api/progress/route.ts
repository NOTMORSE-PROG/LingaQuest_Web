import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthUser } from "@/lib/auth";
import { ISLAND_PASS_THRESHOLD, SERVER_ERRORS } from "@/lib/constants";

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: SERVER_ERRORS.UNAUTHORIZED }, { status: 401 });

    // Fetch all completed progress with accuracy for cumulative unlock logic
    const allProgress = await prisma.progress.findMany({
      where: { userId: auth.userId, isCompleted: true },
      select: { pinId: true, accuracy: true },
    });

    const islands = await prisma.island.findMany({
      include: { pins: { select: { id: true } } },
      orderBy: { number: "asc" },
    });

    const completedPinIds = new Set(allProgress.map((p) => p.pinId));
    const accuracyMap = new Map(allProgress.map((p) => [p.pinId, p.accuracy]));

    const islandProgress = islands.map((island, idx) => {
      const isUnlocked =
        idx === 0
          ? true
          : islands.slice(0, idx).every((prev) => {
              if (!prev.pins.every((p) => completedPinIds.has(p.id))) return false;
              // BUG 7 FIX: island with 0 pins passes vacuously — don't divide by zero
              if (prev.pins.length === 0) return true;
              const avg =
                prev.pins.reduce((sum, p) => sum + (accuracyMap.get(p.id) ?? 0), 0) /
                prev.pins.length;
              return avg >= ISLAND_PASS_THRESHOLD;
            });

      return {
        islandId: island.id,
        completedPins: island.pins.filter((p) => completedPinIds.has(p.id)).length,
        totalPins: island.pins.length,
        isUnlocked,
        isCompleted: island.pins.every((p) => completedPinIds.has(p.id)),
      };
    });

    return NextResponse.json(islandProgress);
  } catch (err: unknown) {
    console.error("[GET /api/progress]", err);
    return NextResponse.json({ error: SERVER_ERRORS.INTERNAL }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: SERVER_ERRORS.UNAUTHORIZED }, { status: 401 });

    // BUG 10 FIX: guard req.json() — malformed body returns 400 not 500
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: SERVER_ERRORS.INVALID_BODY }, { status: 400 });
    }

    const { pinId, hintsUsed, accuracy } = body as Record<string, unknown>;

    if (!pinId || typeof pinId !== "string") {
      return NextResponse.json({ error: "pinId is required." }, { status: 400 });
    }

    // BUG 17 FIX: validate hintsUsed type and range
    if (typeof hintsUsed !== "number" || !Number.isInteger(hintsUsed) || hintsUsed < 0) {
      return NextResponse.json(
        { error: "Invalid hintsUsed. Must be a non-negative integer." },
        { status: 400 }
      );
    }

    const newAccuracy = Math.min(Math.max((accuracy as number) ?? 0, 0), 100);

    // Preserve best score across retries
    const existing = await prisma.progress.findUnique({
      where: { userId_pinId: { userId: auth.userId, pinId } },
    });
    const bestAccuracy = Math.max(existing?.accuracy ?? 0, newAccuracy);
    const isPassed = bestAccuracy >= ISLAND_PASS_THRESHOLD;

    const progress = await prisma.progress.upsert({
      where: { userId_pinId: { userId: auth.userId, pinId } },
      update: {
        isCompleted: true,
        accuracy: bestAccuracy,
        hintsUsed,
        completedAt: new Date(),
      },
      create: {
        userId: auth.userId,
        pinId,
        isCompleted: true,
        accuracy: bestAccuracy,
        hintsUsed,
        completedAt: new Date(),
      },
    });

    // Badge award is best-effort — failure must not fail the progress submission
    try {
      await checkAndAwardBadges(auth.userId);
    } catch (badgeErr: unknown) {
      console.error("[progress] badge award failed — progress still saved:", badgeErr);
    }

    return NextResponse.json({ ...progress, isPassed, passThreshold: ISLAND_PASS_THRESHOLD });
  } catch (err: unknown) {
    console.error("[POST /api/progress]", err);
    return NextResponse.json({ error: SERVER_ERRORS.INTERNAL }, { status: 500 });
  }
}

async function checkAndAwardBadges(userId: string) {
  const progress = await prisma.progress.findMany({
    where: { userId, isCompleted: true },
    include: { pin: { include: { island: true } } },
  });

  const existingBadges = await prisma.badge.findMany({
    where: { userId },
    select: { badgeType: true },
  });
  const earned = new Set(existingBadges.map((b) => b.badgeType));

  const toAward: string[] = [];

  // First Steps: completed at least 1 pin
  if (progress.length >= 1 && !earned.has("first_steps")) {
    toAward.push("first_steps");
  }

  // Sharp Ear: 100% accuracy on any pin
  if (progress.some((p) => p.accuracy === 100) && !earned.has("sharp_ear")) {
    toAward.push("sharp_ear");
  }

  // Never Lost: completed a pin with 0 hints
  if (progress.some((p) => p.hintsUsed === 0 && p.isCompleted) && !earned.has("never_lost")) {
    toAward.push("never_lost");
  }

  // Island badges: check if all pins on an island are done
  const islands = await prisma.island.findMany({
    include: { pins: { select: { id: true } } },
  });
  const completedPinIds = new Set(progress.map((p) => p.pinId));

  for (const island of islands) {
    const badgeKey = `island_${island.number}` as const;
    if (island.pins.every((p) => completedPinIds.has(p.id)) && !earned.has(badgeKey)) {
      toAward.push(badgeKey);
    }
  }

  // Ship Saver: completed an island with avg ≥ threshold but used hints on at least one pin
  if (!earned.has("ship_saver")) {
    const pinProgressMap = new Map(progress.map((p) => [p.pinId, p]));
    const anyIslandPassedWithHints = islands.some(
      (island) =>
        island.pins.every((p) => completedPinIds.has(p.id)) &&
        island.pins.length > 0 &&
        island.pins.reduce(
          (sum, p) => sum + (pinProgressMap.get(p.id)?.accuracy ?? 0),
          0
        ) /
          island.pins.length >=
          ISLAND_PASS_THRESHOLD &&
        island.pins.some((p) => (pinProgressMap.get(p.id)?.hintsUsed ?? 0) > 0)
    );
    if (anyIslandPassedWithHints) {
      toAward.push("ship_saver");
    }
  }

  // The Captain: all islands done
  if (
    islands.every((island) => island.pins.every((p) => completedPinIds.has(p.id))) &&
    !earned.has("the_captain")
  ) {
    toAward.push("the_captain");
    toAward.push("island_conqueror");
  }

  if (toAward.length > 0) {
    await prisma.badge.createMany({
      data: toAward.map((badgeType) => ({ userId, badgeType })),
      skipDuplicates: true,
    });
  }
}
