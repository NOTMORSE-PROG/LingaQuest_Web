import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthUser } from "@/lib/auth";
import { pusher, roomChannel } from "@/lib/pusher";
import { ShipHealth } from "../../../../types/multiplayer";

export async function POST(req: NextRequest) {
  const auth = await getAuthUser(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId } = await req.json();
  if (!roomId) return NextResponse.json({ error: "roomId required." }, { status: 400 });

  const room = await prisma.multiplayerRoom.findUnique({
    where: { id: roomId },
    include: { players: true },
  });

  if (!room) return NextResponse.json({ error: "Room not found." }, { status: 404 });
  if (room.hostId !== auth.userId)
    return NextResponse.json({ error: "Only the host can start rounds." }, { status: 403 });
  if (room.status === "FINISHED")
    return NextResponse.json({ error: "Game is already finished." }, { status: 409 });

  const nextRound = room.currentRound + 1;

  if (nextRound > room.roundCount) {
    await prisma.multiplayerRoom.update({
      where: { id: roomId },
      data: { status: "FINISHED" },
    });
    await pusher.trigger(roomChannel(roomId), "game:end", {
      shipHealth: room.shipHealth,
    });
    return NextResponse.json({ ok: true, ended: true });
  }

  // Pick 5 challenges for this round, cycling through the pool
  const allChallenges = await prisma.challenge.findMany({
    orderBy: [
      { pin: { island: { number: "asc" } } },
      { pin: { number: "asc" } },
      { sortOrder: "asc" },
    ],
    select: { id: true },
  });

  if (allChallenges.length === 0) {
    return NextResponse.json(
      { error: "No challenges in database. Run seed first." },
      { status: 500 }
    );
  }

  const startIdx = ((nextRound - 1) * 5) % allChallenges.length;
  const challengeIds = Array.from(
    { length: 5 },
    (_, i) => allChallenges[(startIdx + i) % allChallenges.length].id
  );

  // Clear any stale repair votes from a previous attempt at this round
  await prisma.repairVoteRecord.deleteMany({
    where: { roomId, round: nextRound },
  });

  await prisma.multiplayerRoom.update({
    where: { id: roomId },
    data: {
      status: "ACTIVE",
      currentRound: nextRound,
      currentQuestion: 0,
      currentPartTarget: null,
      roundChallenges: challengeIds,
    },
  });

  await pusher.trigger(roomChannel(roomId), "repair:start", {
    round: nextRound,
    totalRounds: room.roundCount,
    shipHealth: room.shipHealth,
  });

  return NextResponse.json({ ok: true, round: nextRound });
}
