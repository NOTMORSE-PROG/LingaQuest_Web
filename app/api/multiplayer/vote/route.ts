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

  const { roomId, answer } = await req.json();

  if (!roomId || !answer) {
    return NextResponse.json({ error: "roomId and answer are required." }, { status: 400 });
  }

  if (!["A", "B", "C", "D"].includes(answer)) {
    return NextResponse.json({ error: "answer must be A, B, C, or D." }, { status: 400 });
  }

  const room = await prisma.multiplayerRoom.findUnique({
    where: { id: roomId },
    include: { players: true },
  });

  if (!room || room.status !== "ACTIVE") {
    return NextResponse.json({ error: "Room not active." }, { status: 409 });
  }

  const currentRound = room.currentRound;
  const qIdx = room.currentQuestion;
  const playerCount = room.players.length;

  // Upsert vote
  await prisma.voteRecord.upsert({
    where: {
      roomId_round_questionIndex_userId: {
        roomId,
        round: currentRound,
        questionIndex: qIdx,
        userId: auth.userId,
      },
    },
    update: { chosenAnswer: answer },
    create: {
      roomId,
      round: currentRound,
      questionIndex: qIdx,
      userId: auth.userId,
      chosenAnswer: answer,
    },
  });

  const votes = await prisma.voteRecord.findMany({
    where: { roomId, round: currentRound, questionIndex: qIdx },
  });

  await pusher.trigger(roomChannel(roomId), "vote:update", {
    userId: auth.userId,
    hasVoted: true,
    totalVotes: votes.length,
    totalPlayers: playerCount,
  });

  if (votes.length >= playerCount) {
    await resolveQuestion(roomId, room, votes, currentRound, qIdx);
  }

  return NextResponse.json({ ok: true });
}

async function resolveQuestion(
  roomId: string,
  room: any,
  votes: any[],
  round: number,
  qIdx: number
) {
  // Guard: don't double-resolve
  const existing = await prisma.roundResult.findUnique({
    where: { roomId_round_questionIndex: { roomId, round, questionIndex: qIdx } },
  });
  if (existing) return;

  // Majority vote
  const tally: Record<string, number> = {};
  for (const v of votes) {
    tally[v.chosenAnswer] = (tally[v.chosenAnswer] ?? 0) + 1;
  }
  const crewAnswer = Object.entries(tally).reduce((a, b) => (a[1] >= b[1] ? a : b))[0];

  // Fetch correct answer from this round's challenge pool
  const challengeIds = room.roundChallenges as string[];
  const challenge = await prisma.challenge.findUnique({
    where: { id: challengeIds[qIdx] },
    select: { answer: true },
  });
  const correctAnswer = challenge?.answer ?? "A";
  const isCorrect = crewAnswer === correctAnswer;
  const healthDelta = isCorrect ? 25 : -25;

  const partTarget = room.currentPartTarget as ShipPart;
  const shipHealth = room.shipHealth as ShipHealth;
  const newHealth = applyHealthDelta(shipHealth, partTarget, healthDelta);

  // Auto-shift if chosen part hits 100%
  let newPartTarget: ShipPart | null = null;
  if (newHealth[partTarget] >= 100) {
    newPartTarget = getNextDamagedPart(newHealth, partTarget);
  }
  const nextPartTarget = newPartTarget ?? partTarget;

  const isRoundOver = qIdx === 4;
  const gameOver = isShipSunk(newHealth) || (isRoundOver && round >= room.roundCount);

  await prisma.$transaction([
    prisma.roundResult.upsert({
      where: { roomId_round_questionIndex: { roomId, round, questionIndex: qIdx } },
      update: { crewAnswer, correctAnswer, isCorrect, healthDelta, partTarget },
      create: { roomId, round, questionIndex: qIdx, crewAnswer, correctAnswer, isCorrect, healthDelta, partTarget },
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
    // Badge awards run async — don't await to avoid blocking
    awardMultiplayerBadges(roomId, room.players.map((p: any) => p.userId), newHealth).catch(() => {});
    return;
  }

  if (isRoundOver) {
    await pusher.trigger(roomChannel(roomId), "round:end", {
      round,
      totalRounds: room.roundCount,
      shipHealth: newHealth,
    });
  }
}

async function awardMultiplayerBadges(
  roomId: string,
  playerIds: string[],
  finalHealth: ShipHealth
) {
  const room = await prisma.multiplayerRoom.findUnique({
    where: { id: roomId },
    include: { rounds: true },
  });
  if (!room) return;

  const allResults = room.rounds;
  const won = crewWins(finalHealth);

  for (const userId of playerIds) {
    const toAward: string[] = [];

    // unsinkable: all 5 parts at 100
    if (Object.values(finalHealth).every((hp) => (hp as number) >= 100)) {
      toAward.push("unsinkable");
    }

    // true_crew: won with zero wrong votes
    if (won && allResults.every((r) => r.isCorrect)) {
      toAward.push("true_crew");
    }

    // unanimous: any question where all votes matched the correct answer
    const questionGroups = await prisma.voteRecord.groupBy({
      by: ["round", "questionIndex"],
      where: { roomId },
    });
    for (const g of questionGroups) {
      const questionVotes = await prisma.voteRecord.findMany({
        where: { roomId, round: g.round, questionIndex: g.questionIndex },
      });
      const result = allResults.find(
        (r) => r.round === g.round && r.questionIndex === g.questionIndex
      );
      if (
        result?.isCorrect &&
        questionVotes.length > 0 &&
        questionVotes.every((v) => v.chosenAnswer === result.crewAnswer)
      ) {
        toAward.push("unanimous");
        break;
      }
    }

    // ship_saver: won ≥3 sessions total
    if (won) {
      const wins = await prisma.multiplayerRoom.count({
        where: {
          status: "FINISHED",
          players: { some: { userId } },
        },
      });
      // We check after this win is recorded; wins ≥ 3 (this session may or may not be counted yet)
      if (wins >= 3) toAward.push("ship_saver");
    }

    // Award all badges (upsert — idempotent)
    for (const badgeType of [...new Set(toAward)]) {
      await prisma.badge.upsert({
        where: { userId_badgeType: { userId, badgeType } },
        update: {},
        create: { userId, badgeType },
      });
    }
  }
}
