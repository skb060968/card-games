/**
 * Bluff — Game Engine
 *
 * Pure game logic: create, place cards, challenge resolution,
 * turn management, win detection, validation, serialization.
 * No DOM or Firebase dependencies.
 *
 * Flow: Player places cards → turn advances to next player immediately.
 * Any non-placer can press Bluff before the next player acts.
 * Once the next player places or passes, the previous placement
 * can no longer be challenged.
 */

import { createDeck, shuffle, dealCards, serializeCard, deserializeCard } from '../../shared/deck.js';

/* ======= CONSTANTS ======= */

const VALID_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/* ======= GAME CREATION ======= */

/**
 * Creates initial Bluff game state.
 * @param {Array<{name: string, emoji: string}>} playerInfos — 2 to 4 players
 * @returns {object} GameState
 */
export function createGame(playerInfos) {
  const n = playerInfos.length;
  if (n < 2 || n > 4) {
    throw new Error(`Invalid player count: ${n}. Must be 2-4 players.`);
  }

  const deck = createDeck();
  shuffle(deck);
  const hands = dealCards(deck, n);

  const players = playerInfos.map((info, i) => ({
    name: info.name,
    emoji: info.emoji,
    hand: hands[i],
    connected: true,
  }));

  return {
    players,
    centerPile: [],
    currentPlayerIndex: 0,
    phase: 'placing',
    lastPlacement: null,
    status: 'playing',
    winnerIndex: null,
    deckSize: 52,
    currentRank: null,
    roundStartPlayer: 0,
    playersActedThisRound: [],
  };
}

/* ======= CARD PLACEMENT ======= */

/**
 * Places 1–4 cards from the active player's hand onto the center pile.
 * Advances turn to next player immediately. lastPlacement is kept
 * so other players can challenge before the next player acts.
 * @param {object} state
 * @param {number[]} cardIndices
 * @param {string} declaredRank
 * @returns {object} new GameState
 */
export function placeCards(state, cardIndices, declaredRank) {
  if (state.phase !== 'placing') {
    throw new Error('Cannot place cards: not in placing phase');
  }

  if (!cardIndices || cardIndices.length < 1 || cardIndices.length > 4) {
    throw new Error(`Must place 1-4 cards, got ${cardIndices ? cardIndices.length : 0}`);
  }

  if (!VALID_RANKS.includes(declaredRank)) {
    throw new Error(`Invalid declared rank: ${declaredRank}`);
  }

  // Round-based rank enforcement
  if (state.currentRank !== null && state.currentRank !== undefined && declaredRank !== state.currentRank) {
    throw new Error(`Must declare ${state.currentRank} this round (got ${declaredRank})`);
  }

  const playerIdx = state.currentPlayerIndex;
  const player = state.players[playerIdx];

  // Validate indices
  const uniqueIndices = [...new Set(cardIndices)].sort((a, b) => b - a);
  if (uniqueIndices.length !== cardIndices.length) {
    throw new Error('Duplicate card indices');
  }

  for (const idx of uniqueIndices) {
    if (idx < 0 || idx >= player.hand.length) {
      throw new Error(`Card index ${idx} out of range (hand size: ${player.hand.length})`);
    }
  }

  // Extract actual cards and remove from hand
  const actualCards = cardIndices.map((idx) => player.hand[idx]);
  const newHand = [...player.hand];
  for (const idx of uniqueIndices) {
    newHand.splice(idx, 1);
  }

  const newCenterPile = [...state.centerPile, ...actualCards];

  const newPlayers = state.players.map((p, i) => {
    if (i === playerIdx) return { ...p, hand: newHand };
    return { ...p };
  });

  const newCurrentRank = state.currentRank || declaredRank;

  const newPlayersActed = state.playersActedThisRound
    ? [...state.playersActedThisRound]
    : [];
  if (!newPlayersActed.includes(playerIdx)) {
    newPlayersActed.push(playerIdx);
  }

  const numPlayers = state.players.length;
  const nextPlayer = (playerIdx + 1) % numPlayers;

  // Check if placer's hand is empty — potential win (can still be challenged)
  const placerEmpty = newHand.length === 0;

  return {
    ...state,
    players: newPlayers,
    centerPile: newCenterPile,
    phase: 'placing',
    currentPlayerIndex: nextPlayer,
    lastPlacement: {
      playerIndex: playerIdx,
      actualCards,
      declaredRank,
      count: actualCards.length,
      placerEmpty,
    },
    currentRank: newCurrentRank,
    roundStartPlayer: state.currentRank ? state.roundStartPlayer : playerIdx,
    playersActedThisRound: newPlayersActed,
  };
}

/* ======= PASS TURN ======= */

/**
 * Current player passes their turn. Clears lastPlacement (no more challenge).
 * Checks if previous placer won (empty hand, unchallenged).
 * @param {object} state
 * @returns {object} new GameState
 */
export function passCard(state) {
  if (state.phase !== 'placing') {
    throw new Error('Cannot pass: not in placing phase');
  }

  if (state.currentRank === null || state.currentRank === undefined) {
    throw new Error('Cannot pass: you must pick a rank first (no current rank set)');
  }

  // Check if previous placer had empty hand (unchallenged win)
  if (state.lastPlacement && state.lastPlacement.placerEmpty) {
    return {
      ...state,
      phase: 'finished',
      status: 'finished',
      winnerIndex: state.lastPlacement.playerIndex,
      lastPlacement: null,
    };
  }

  const playerIdx = state.currentPlayerIndex;
  const numPlayers = state.players.length;

  const newPlayersActed = state.playersActedThisRound
    ? [...state.playersActedThisRound]
    : [];
  if (!newPlayersActed.includes(playerIdx)) {
    newPlayersActed.push(playerIdx);
  }

  const roundComplete = newPlayersActed.length >= numPlayers;
  const nextPlayer = (playerIdx + 1) % numPlayers;

  if (roundComplete) {
    return {
      ...state,
      currentPlayerIndex: nextPlayer,
      phase: 'placing',
      lastPlacement: null,
      currentRank: null,
      roundStartPlayer: nextPlayer,
      playersActedThisRound: [],
    };
  }

  return {
    ...state,
    currentPlayerIndex: nextPlayer,
    phase: 'placing',
    lastPlacement: null,
    playersActedThisRound: newPlayersActed,
  };
}

/* ======= CHALLENGE RESOLUTION ======= */

/**
 * Resolves a challenge against the most recent placement.
 * Can be called anytime lastPlacement exists and challenger is not the placer.
 * @param {object} state
 * @param {number} challengerIndex
 * @returns {{ newState: object, bluffCaught: boolean, revealedCards: Array }}
 */
export function resolveChallenge(state, challengerIndex) {
  if (!state.lastPlacement) {
    throw new Error('No placement to challenge');
  }

  const placerIndex = state.lastPlacement.playerIndex;

  if (challengerIndex === placerIndex) {
    throw new Error('Cannot challenge your own placement');
  }

  if (challengerIndex < 0 || challengerIndex >= state.players.length) {
    throw new Error(`Invalid challenger index: ${challengerIndex}`);
  }

  const { actualCards, declaredRank } = state.lastPlacement;
  const revealedCards = [...actualCards];

  const bluffCaught = actualCards.some((card) => card.rank !== declaredRank);

  const loserIndex = bluffCaught ? placerIndex : challengerIndex;
  const pileCards = [...state.centerPile];

  const newPlayers = state.players.map((p, i) => {
    if (i === loserIndex) {
      return { ...p, hand: [...p.hand, ...pileCards] };
    }
    return { ...p };
  });

  const nextPlayer = (placerIndex + 1) % state.players.length;

  return {
    newState: {
      ...state,
      players: newPlayers,
      centerPile: [],
      currentPlayerIndex: nextPlayer,
      phase: 'placing',
      lastPlacement: null,
      status: 'playing',
      currentRank: null,
      roundStartPlayer: nextPlayer,
      playersActedThisRound: [],
    },
    bluffCaught,
    revealedCards,
  };
}

/* ======= STATE VALIDATION ======= */

/**
 * Validates state integrity: total cards across all hands + centerPile = 52.
 * @param {object} state
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateState(state) {
  let total = state.centerPile.length;
  for (const player of state.players) {
    total += player.hand.length;
  }

  if (total !== 52) {
    return { valid: false, error: `Card count mismatch: expected 52, found ${total}` };
  }
  return { valid: true };
}

/* ======= SERIALIZATION ======= */

/**
 * Serializes game state for Firebase storage.
 * @param {object} state
 * @returns {object}
 */
export function serializeState(state) {
  const hands = {};
  const handCounts = {};

  state.players.forEach((p, i) => {
    const key = `player_${i}`;
    hands[key] = p.hand.map(serializeCard);
    handCounts[key] = p.hand.length;
  });

  let lastPlacement = null;
  if (state.lastPlacement) {
    lastPlacement = {
      playerIndex: state.lastPlacement.playerIndex,
      actualCards: state.lastPlacement.actualCards.map(serializeCard),
      declaredRank: state.lastPlacement.declaredRank,
      count: state.lastPlacement.count,
      placerEmpty: state.lastPlacement.placerEmpty || false,
    };
  }

  return {
    currentPlayerIndex: state.currentPlayerIndex,
    phase: state.phase,
    status: state.status,
    deckSize: state.deckSize,
    winnerIndex: state.winnerIndex != null ? state.winnerIndex : null,
    centerPile: state.centerPile.map(serializeCard),
    hands,
    handCounts,
    lastPlacement,
    currentRank: state.currentRank || null,
    roundStartPlayer: state.roundStartPlayer || 0,
    playersActedThisRound: state.playersActedThisRound || [],
  };
}

/**
 * Deserializes game state from Firebase data.
 * @param {object} gameData
 * @param {object} playersData
 * @returns {object}
 */
export function deserializeState(gameData, playersData) {
  const playerKeys = Object.keys(playersData).sort();
  const players = playerKeys.map((key, i) => {
    const pData = playersData[key];
    const rawHand = (gameData.hands && gameData.hands[key]) || [];
    const hand = Array.isArray(rawHand)
      ? rawHand.map(deserializeCard)
      : Object.values(rawHand).map(deserializeCard);

    return {
      name: pData.name || `Player ${i + 1}`,
      emoji: pData.emoji || '😀',
      hand,
      connected: pData.connected !== false,
    };
  });

  const rawPile = gameData.centerPile || [];
  const centerPile = Array.isArray(rawPile)
    ? rawPile.map(deserializeCard)
    : Object.values(rawPile).map(deserializeCard);

  let lastPlacement = null;
  if (gameData.lastPlacement) {
    const lp = gameData.lastPlacement;
    const rawActual = lp.actualCards || [];
    const actualCards = Array.isArray(rawActual)
      ? rawActual.map(deserializeCard)
      : Object.values(rawActual).map(deserializeCard);

    lastPlacement = {
      playerIndex: lp.playerIndex,
      actualCards,
      declaredRank: lp.declaredRank,
      count: lp.count,
      placerEmpty: lp.placerEmpty || false,
    };
  }

  return {
    players,
    centerPile,
    currentPlayerIndex: gameData.currentPlayerIndex || 0,
    phase: gameData.phase || 'placing',
    lastPlacement,
    status: gameData.status || 'playing',
    winnerIndex: gameData.winnerIndex != null ? gameData.winnerIndex : null,
    deckSize: gameData.deckSize || 52,
    currentRank: gameData.currentRank || null,
    roundStartPlayer: gameData.roundStartPlayer || 0,
    playersActedThisRound: gameData.playersActedThisRound
      ? (Array.isArray(gameData.playersActedThisRound)
          ? gameData.playersActedThisRound
          : Object.values(gameData.playersActedThisRound))
      : [],
  };
}
