/**
 * Poker — Game Engine
 *
 * Pure game logic for 3-card poker: game creation, hand evaluation,
 * betting actions, round resolution, state validation, serialization.
 * No DOM or Firebase dependencies.
 */

import { createDeck, shuffle, serializeCard, deserializeCard } from '../../shared/deck.js';

/* ======= CONSTANTS ======= */

const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

const CATEGORY_TRAIL = 5;
const CATEGORY_PURE_SEQUENCE = 4;
const CATEGORY_SEQUENCE = 3;
const CATEGORY_COLOR = 2;
const CATEGORY_PAIR = 1;
const CATEGORY_HIGH_CARD = 0;

const CATEGORY_LABELS = {
  [CATEGORY_TRAIL]: 'Trail',
  [CATEGORY_PURE_SEQUENCE]: 'Pure Sequence',
  [CATEGORY_SEQUENCE]: 'Sequence',
  [CATEGORY_COLOR]: 'Color',
  [CATEGORY_PAIR]: 'Pair',
  [CATEGORY_HIGH_CARD]: 'High Card',
};

const BET_AMOUNT = 10;
const RAISE_AMOUNT = 20;
const STARTING_CHIPS = 100;

/* ======= GAME CREATION ======= */

/**
 * Creates initial Poker game state.
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

  // Deal 3 cards to each player
  const players = playerInfos.map((info, i) => ({
    name: info.name,
    emoji: info.emoji,
    hand: deck.slice(i * 3, i * 3 + 3),
    chips: STARTING_CHIPS,
    currentBet: 0,
    folded: false,
    hasActed: false,
    connected: true,
  }));

  return {
    players,
    pot: 0,
    currentPlayerIndex: 0,
    status: 'betting',
    winnerIndex: null,
    showEligible: false,
  };
}

/* ======= HAND EVALUATION ======= */

/**
 * Returns the numeric value of a card rank.
 * Ace is 14 by default (high).
 * @param {string} rank
 * @returns {number}
 */
function rankValue(rank) {
  return RANK_VALUES[rank] || 0;
}

/**
 * Checks if three card values form a consecutive sequence.
 * Handles ace-low (A-2-3) and ace-high (Q-K-A).
 * K-A-2 is NOT valid.
 * @param {number[]} values — sorted ascending array of 3 rank values
 * @returns {{ isSequence: boolean, highValue: number }}
 */
function checkSequence(values) {
  const [a, b, c] = values; // sorted ascending

  // Normal consecutive: each differs by 1
  if (b - a === 1 && c - b === 1) {
    return { isSequence: true, highValue: c };
  }

  // Ace-low: A(14), 2, 3 → sorted as [2, 3, 14]
  if (a === 2 && b === 3 && c === 14) {
    return { isSequence: true, highValue: 3 }; // 3 is high in A-2-3
  }

  return { isSequence: false, highValue: c };
}

/**
 * Evaluates a 3-card hand and returns its ranking.
 * @param {Array<{rank: string, suit: string}>} hand — exactly 3 cards
 * @returns {{ category: number, label: string, score: number, sortedValues: number[] }}
 */
export function evaluateHand(hand) {
  if (!hand || hand.length !== 3) {
    throw new Error(`Hand must have exactly 3 cards, got ${hand ? hand.length : 0}`);
  }

  const values = hand.map((c) => rankValue(c.rank)).sort((a, b) => a - b);
  const suits = hand.map((c) => c.suit);
  const allSameSuit = suits[0] === suits[1] && suits[1] === suits[2];

  // Check Trail (three of a kind)
  if (values[0] === values[1] && values[1] === values[2]) {
    const score = CATEGORY_TRAIL * 1000000 + values[2] * 10000 + values[1] * 100 + values[0];
    return { category: CATEGORY_TRAIL, label: 'Trail', score, sortedValues: values };
  }

  // Check sequence
  const { isSequence, highValue } = checkSequence(values);

  if (isSequence && allSameSuit) {
    // Pure Sequence (Straight Flush)
    // For scoring, use the high value of the sequence
    const score = CATEGORY_PURE_SEQUENCE * 1000000 + highValue * 10000;
    return { category: CATEGORY_PURE_SEQUENCE, label: 'Pure Sequence', score, sortedValues: values };
  }

  if (isSequence) {
    // Sequence (Straight)
    const score = CATEGORY_SEQUENCE * 1000000 + highValue * 10000;
    return { category: CATEGORY_SEQUENCE, label: 'Sequence', score, sortedValues: values };
  }

  if (allSameSuit) {
    // Color (Flush) — same suit, not consecutive
    const score = CATEGORY_COLOR * 1000000 + values[2] * 10000 + values[1] * 100 + values[0];
    return { category: CATEGORY_COLOR, label: 'Color', score, sortedValues: values };
  }

  // Check Pair
  if (values[0] === values[1] || values[1] === values[2]) {
    let pairRank, kicker;
    if (values[0] === values[1]) {
      pairRank = values[0];
      kicker = values[2];
    } else {
      pairRank = values[1];
      kicker = values[0];
    }
    const score = CATEGORY_PAIR * 1000000 + pairRank * 10000 + kicker * 100;
    return { category: CATEGORY_PAIR, label: 'Pair', score, sortedValues: values };
  }

  // High Card
  const score = CATEGORY_HIGH_CARD * 1000000 + values[2] * 10000 + values[1] * 100 + values[0];
  return { category: CATEGORY_HIGH_CARD, label: 'High Card', score, sortedValues: values };
}

/**
 * Returns a comparable numeric score for a 3-card hand.
 * Higher score = better hand.
 * @param {Array<{rank: string, suit: string}>} hand
 * @returns {number}
 */
export function handScore(hand) {
  return evaluateHand(hand).score;
}

/**
 * Returns a human-readable label for a hand category number.
 * @param {number} category
 * @returns {string}
 */
export function getHandLabel(category) {
  return CATEGORY_LABELS[category] || 'Unknown';
}

/* ======= BETTING ACTIONS ======= */

/**
 * Returns the list of active (non-folded) player indices.
 * @param {object} state
 * @returns {number[]}
 */
function getActivePlayers(state) {
  return state.players
    .map((p, i) => ({ index: i, folded: p.folded }))
    .filter((p) => !p.folded)
    .map((p) => p.index);
}

/**
 * Advances to the next active (non-folded) player.
 * @param {object} state
 * @returns {number} next player index
 */
function nextActivePlayer(state) {
  const n = state.players.length;
  let idx = (state.currentPlayerIndex + 1) % n;
  let attempts = 0;
  while (state.players[idx].folded && attempts < n) {
    idx = (idx + 1) % n;
    attempts++;
  }
  return idx;
}

/**
 * Checks if the Show option should be available.
 * Show is available when all active players have acted at least once
 * and all active player bets are equal.
 * @param {object} state
 * @returns {boolean}
 */
function checkShowEligible(state) {
  const activePlayers = getActivePlayers(state);
  if (activePlayers.length < 2) return false;

  const allActed = activePlayers.every((i) => state.players[i].hasActed);
  if (!allActed) return false;

  const bets = activePlayers.map((i) => state.players[i].currentBet);
  const allEqual = bets.every((b) => b === bets[0]);
  return allEqual;
}

/**
 * Performs a betting action for the current player.
 * @param {object} state
 * @param {number} playerIndex
 * @param {{ type: 'bet' | 'raise' | 'call' | 'fold' | 'show' }} action
 * @returns {object} new GameState
 */
export function performAction(state, playerIndex, action) {
  if (state.status !== 'betting') {
    throw new Error('Cannot perform action: game is not in betting phase');
  }

  if (playerIndex !== state.currentPlayerIndex) {
    throw new Error(`Not player ${playerIndex}'s turn. Current player: ${state.currentPlayerIndex}`);
  }

  const player = state.players[playerIndex];
  if (player.folded) {
    throw new Error('Folded player cannot act');
  }

  const newPlayers = state.players.map((p) => ({ ...p }));
  let newPot = state.pot;
  let newStatus = state.status;
  let newWinnerIndex = state.winnerIndex;

  switch (action.type) {
    case 'bet': {
      if (player.chips < BET_AMOUNT) {
        throw new Error(`Insufficient chips for bet. Have ${player.chips}, need ${BET_AMOUNT}`);
      }
      newPlayers[playerIndex].chips -= BET_AMOUNT;
      newPlayers[playerIndex].currentBet += BET_AMOUNT;
      newPot += BET_AMOUNT;
      newPlayers[playerIndex].hasActed = true;
      break;
    }

    case 'raise': {
      if (player.chips < RAISE_AMOUNT) {
        throw new Error(`Insufficient chips for raise. Have ${player.chips}, need ${RAISE_AMOUNT}`);
      }
      newPlayers[playerIndex].chips -= RAISE_AMOUNT;
      newPlayers[playerIndex].currentBet += RAISE_AMOUNT;
      newPot += RAISE_AMOUNT;
      newPlayers[playerIndex].hasActed = true;
      break;
    }

    case 'call': {
      const activePlayers = getActivePlayers(state);
      const maxBet = Math.max(...activePlayers.map((i) => state.players[i].currentBet));
      const callAmount = maxBet - player.currentBet;
      if (callAmount <= 0) {
        throw new Error('Nothing to call — bets are already equal');
      }
      if (player.chips < callAmount) {
        throw new Error(`Insufficient chips for call. Have ${player.chips}, need ${callAmount}`);
      }
      newPlayers[playerIndex].chips -= callAmount;
      newPlayers[playerIndex].currentBet += callAmount;
      newPot += callAmount;
      newPlayers[playerIndex].hasActed = true;
      break;
    }

    case 'fold': {
      newPlayers[playerIndex].folded = true;
      newPlayers[playerIndex].hasActed = true;

      // Check last-player-standing
      const remaining = newPlayers.filter((p) => !p.folded);
      if (remaining.length === 1) {
        const winnerIdx = newPlayers.findIndex((p) => !p.folded);
        newPlayers[winnerIdx].chips += newPot;
        newPot = 0;
        newStatus = 'finished';
        newWinnerIndex = winnerIdx;

        return {
          ...state,
          players: newPlayers,
          pot: newPot,
          status: newStatus,
          winnerIndex: newWinnerIndex,
          showEligible: false,
        };
      }
      break;
    }

    case 'show': {
      if (!state.showEligible) {
        throw new Error('Show is not available yet');
      }
      // Resolve the show
      return resolveShow({
        ...state,
        players: newPlayers,
        pot: newPot,
      });
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  // Advance turn
  const tempState = {
    ...state,
    players: newPlayers,
    pot: newPot,
    status: newStatus,
    winnerIndex: newWinnerIndex,
  };

  const nextIdx = nextActivePlayer(tempState);
  const showEligible = checkShowEligible({
    ...tempState,
    currentPlayerIndex: nextIdx,
  });

  return {
    ...tempState,
    currentPlayerIndex: nextIdx,
    showEligible,
  };
}

/* ======= ROUND RESOLUTION ======= */

/**
 * Resolves the show phase: evaluates all active hands, determines winner, awards pot.
 * @param {object} state
 * @returns {object} new GameState with status='finished'
 */
export function resolveShow(state) {
  const activePlayers = getActivePlayers(state);
  if (activePlayers.length < 2) {
    throw new Error('Need at least 2 active players for show');
  }

  // Evaluate all active hands
  let bestScore = -1;
  let bestPlayerIndex = -1;

  for (const idx of activePlayers) {
    const score = handScore(state.players[idx].hand);
    if (score > bestScore || (score === bestScore && idx < bestPlayerIndex)) {
      bestScore = score;
      bestPlayerIndex = idx;
    }
  }

  const newPlayers = state.players.map((p) => ({ ...p }));
  newPlayers[bestPlayerIndex].chips += state.pot;

  return {
    ...state,
    players: newPlayers,
    pot: 0,
    status: 'finished',
    winnerIndex: bestPlayerIndex,
    showEligible: false,
  };
}

/* ======= STATE VALIDATION ======= */

/**
 * Validates game state integrity.
 * Checks: chip conservation, hand sizes, no duplicate cards.
 * @param {object} state
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateState(state) {
  const n = state.players.length;
  const expectedTotal = STARTING_CHIPS * n;

  // Chip conservation
  let totalChips = state.pot;
  for (const player of state.players) {
    totalChips += player.chips;
  }
  if (totalChips !== expectedTotal) {
    return { valid: false, error: `Chip count mismatch: expected ${expectedTotal}, found ${totalChips}` };
  }

  // Hand sizes
  for (let i = 0; i < n; i++) {
    if (state.players[i].hand.length !== 3) {
      return { valid: false, error: `Player ${i} has ${state.players[i].hand.length} cards, expected 3` };
    }
  }

  // No duplicate cards
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    for (const card of state.players[i].hand) {
      const key = `${card.rank}${card.suit}`;
      if (seen.has(key)) {
        return { valid: false, error: `Duplicate card found: ${key}` };
      }
      seen.add(key);
    }
  }

  return { valid: true };
}

/* ======= SERIALIZATION ======= */

/**
 * Serializes game state for Firebase storage.
 * @param {object} state
 * @returns {object} Firebase-compatible plain object
 */
export function serializeState(state) {
  const hands = {};
  const chips = {};
  const currentBets = {};
  const folded = {};
  const hasActed = {};

  state.players.forEach((p, i) => {
    const key = `player_${i}`;
    hands[key] = p.hand.map(serializeCard);
    chips[key] = p.chips;
    currentBets[key] = p.currentBet;
    folded[key] = p.folded;
    hasActed[key] = p.hasActed;
  });

  return {
    hands,
    chips,
    currentBets,
    folded,
    hasActed,
    pot: state.pot,
    currentPlayerIndex: state.currentPlayerIndex,
    status: state.status,
    winnerIndex: state.winnerIndex != null ? state.winnerIndex : null,
    showEligible: state.showEligible || false,
  };
}

/**
 * Deserializes game state from Firebase data.
 * @param {object} gameData — serialized game data from Firebase
 * @param {object} playersData — player info from Firebase
 * @returns {object} GameState
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
      chips: (gameData.chips && gameData.chips[key]) != null ? gameData.chips[key] : STARTING_CHIPS,
      currentBet: (gameData.currentBets && gameData.currentBets[key]) || 0,
      folded: (gameData.folded && gameData.folded[key]) || false,
      hasActed: (gameData.hasActed && gameData.hasActed[key]) || false,
      connected: pData.connected !== false,
    };
  });

  return {
    players,
    pot: gameData.pot || 0,
    currentPlayerIndex: gameData.currentPlayerIndex || 0,
    status: gameData.status || 'betting',
    winnerIndex: gameData.winnerIndex != null ? gameData.winnerIndex : null,
    showEligible: gameData.showEligible || false,
  };
}
