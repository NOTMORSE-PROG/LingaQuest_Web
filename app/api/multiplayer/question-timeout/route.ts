import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthUser } from "@/lib/auth";
import { pusher, roomChannel } from "@/lib/pusher";
import {
  applyHealthDelta,
  isShipSunk,
  crewWins,
  getNextDamagedPart,
} from "@/lib/ship";
import { ShipHealth, ShipPart } from "../../../../types/multiplayer";

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
    return NextResponse.json({ error: "Only the host can trigger a timeout." }, { status: 403 });
  if (room.status !== "ACTIVE")
    return NextResponse.json({ error: "Room is not active." }, { status: 409 });

  const currentRound = room.currentRound;
  const qIdx = room.currentQuestion;

  // Guard: if already resolved, do nothing
  const existing = await prisma.roundResult.findUnique({
    where: { roomId_round_questionIndex: { roomId, round: currentRound, questionIndex: qIdx } },
  });
  if (existing) return NextResponse.json({ ok: true });

  // Get existing votes (may be partial or empty)
  const votes = await prisma.voteRecord.findMany({
    where: { roomId, round: currentRound, questionIndex: qIdx },
  });

  const partTarget = room.currentPartTarget as ShipPart;
  const shipHealth = room.shipHealth as unknown as ShipHealth;

  let crewAnswer: string;
  let correctAnswer: string;
  let isCorrect: boolean;

  if (votes.length === 0) {
    // No votes = automatic wrong
    const challengeIds = room.roundChallenges as string[];
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeIds[qIdx] },
      select: { answer: true },
    });
    correctAnswer = challenge?.answer ?? "A";
    crewAnswer = correctAnswer === "A" ? "B" : "A"; // guaranteed wrong
    isCorrect = false;
  } else {
    // Majority of what exists
    const tally: Record<string, number> = {};
    for (const v of votes) {
      tally[v.chosenAnswer] = (tally[v.chosenAnswer] ?? 0) + 1;
    }
    crewAnswer = Object.entries(tally).reduce((a, b) => (a[1] >= b[1] ? a : b))[0];

    const challengeIds = room.roundChallenges as string[];
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeIds[qIdx] },
      select: { answer: true },
    });
    correctAnswer = challenge?.answer ?? "A";
    isCorrect = crewAnswer === correctAnswer;
  }

  const healthDelta = isCorrect ? 25 : -25;
  const newHealth = applyHealthDelta(shipHealth, partTarget, healthDelta);

  let newPartTarget: ShipPart | null = null;
  if (newHealth[partTarget] >= 100) {
    newPartTarget = getNextDamagedPart(newHealth, partTarget);
  }
  const nextPartTarget = newPartTarget ?? partTarget;

  const isRoundOver = qIdx === 4;
  const gameOver = isShipSunk(newHealth) || (isRoundOver && currentRound >= room.roundCount);

  await prisma.$transaction([
    prisma.roundResult.upsert({
      where: { roomId_round_questionIndex: { roomId, round: currentRound, questionIndex: qIdx } },
      update: { crewAnswer, correctAnswer, isCorrect, healthDelta, partTarget },
      create: { roomId, round: currentRound, questionIndex: qIdx, crewAnswer, correctAnswer, isCorrect, healthDelta, partTarget },
    }),
    prisma.multiplayerRoom.update({
      where: { id: roomId },
      data: {
        shipHealth: newHealth as object,
        currentQuestion: qIdx + 1,
        currentPartTarget: nextPartTarget,
        ...(gameOver ? { status: "FINISHED" } : {}),
      },
    }),
  ]);

  await pusher.trigger(roomChannel(roomId), "round:result", {
    crewAnswer,
    correctAnswer,
    isCorrect,
    healthDelta,
    partTarget,
    newShipHealth: newHealth,
    questionIndex: qIdx,
    isRoundOver,
    ...(newPartTarget ? { newPartTarget } : {}),
  });

  if (gameOver) {
    await pusher.trigger(roomChannel(roomId), "game:end", { shipHealth: newHealth });
    return NextResponse.json({ ok: true });
  }

  if (isRoundOver) {
    await pusher.trigger(roomChannel(roomId), "round:end", {
      round: currentRound,
      totalRounds: room.roundCount,
      shipHealth: newHealth,
    });
  }

  return NextResponse.json({ ok: true });
}
