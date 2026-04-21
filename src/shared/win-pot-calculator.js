/**
 * Win Pot Calculator — Shared Utility Module
 *
 * Computes cosmetic pot values and player metrics for the results screen
 * of each card game. Pure functions with no DOM or Firebase dependencies.
 */

/* ======= RANK VALUE MAP ======= */

const RANK_POINT_VALUES = {
  'A': 1, '2': 2, '3': 3, '4': 4, '5': 5,
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 10, 'Q': 10, 'K': 10,
};

const TARGET_RANKS = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

/**
 * Returns the point value of a card for Simple Rummy scoring.
 * A=1, 2-10=face value, J/Q/K=10.
 * @param {{ rank: string }} card
 * @returns {number}
 */
export function cardPointValue(card) {
  if (!card || !card.rank) return 0;
  return RANK_POINT_VALUES[card.rank] || 0;
}

/**
 * Computes the cosmetic pot value for a finished game.
 * @param {string} gameId — one of the supported game IDs
 * @param {object} gameState — the final game state object
 * @returns {number} non-negative integer pot value (0 if no valid winner)
 */
export function calculatePot(gameId, gameState) {
  if (!gameState || gameState.winnerIndex == null || gameState.winnerIndex === undefined) {
    return 0;
  }

  const players = gameState.players;
  if (!players || !Array.isArray(players)) return 0;

  const winnerIdx = gameState.winnerIndex;
  if (winnerIdx < 0 || winnerIdx >= players.length) return 0;

  const winner = players[winnerIdx];
  if (!winner) return 0;

  switch (gameId) {
    case 'patte-par-patta': {
      // Pot = winner's hand size (all cards they hold at game end)
      const hand = winner.hand || [];
      return Math.max(0, hand.length);
    }

    case 'simple-rummy': {
      // Pot = sum of card point values across all losing players' hands
      let total = 0;
      players.forEach((p, i) => {
        if (i === winnerIdx) return;
        const hand = p.hand || [];
        for (const card of hand) {
          total += cardPointValue(card);
        }
      });
      return Math.max(0, Math.floor(total));
    }

    case 'bluff': {
      // Pot = total cards remaining across all other players' hands
      let total = 0;
      players.forEach((p, i) => {
        if (i === winnerIdx) return;
        total += (p.hand || []).length;
      });
      return Math.max(0, total);
    }

    case 'flip-and-match': {
      // Pot = winner's matched pairs × 10
      const collected = winner.collected || [];
      const pairs = Math.floor(collected.length / 2);
      return Math.max(0, pairs * 10);
    }

    case 'perfect-ten': {
      // Fixed reward for completing all 10 ranks
      return 100;
    }

    default:
      return 0;
  }
}

/**
 * Returns a formatted metric string for a player in the results standings.
 * @param {string} gameId
 * @param {object} gameState
 * @param {number} playerIndex
 * @returns {string}
 */
export function getPlayerMetric(gameId, gameState, playerIndex) {
  if (!gameState || !gameState.players || playerIndex < 0 || playerIndex >= gameState.players.length) {
    return '';
  }

  const player = gameState.players[playerIndex];
  if (!player) return '';

  switch (gameId) {
    case 'patte-par-patta': {
      const hand = player.hand || [];
      if (player.eliminated) return '❌ Out';
      return `🃏 ${hand.length} cards`;
    }

    case 'simple-rummy': {
      if (gameState.winnerIndex === playerIndex) return '🏆 Winner';
      const hand = player.hand || [];
      let pts = 0;
      for (const card of hand) {
        pts += cardPointValue(card);
      }
      return `📊 ${pts} pts`;
    }

    case 'bluff': {
      const hand = player.hand || [];
      return `🃏 ${hand.length} cards`;
    }

    case 'flip-and-match': {
      const collected = player.collected || [];
      const pairs = Math.floor(collected.length / 2);
      return `🃏 ${pairs} pairs`;
    }

    case 'perfect-ten': {
      const hand = player.hand || [];
      const collected = new Set();
      for (const card of hand) {
        if (card && TARGET_RANKS.has(card.rank)) {
          collected.add(card.rank);
        }
      }
      return `🎯 ${collected.size}/10 ranks`;
    }

    default:
      return '';
  }
}

/**
 * Creates a DOM element showing a CSS coin stack with the pot value.
 * Returns a div.winner-pot containing a coin stack and the numeric value.
 * The coin stack height scales with the pot value (3-5 coins).
 * @param {number} pot — the pot value to display
 * @returns {HTMLElement} the pot display element
 */
export function renderPotDisplay(pot) {
  const container = document.createElement('div');
  container.className = 'winner-pot';

  // Coin stack — 3 to 5 coins based on pot size
  const stack = document.createElement('div');
  stack.className = 'coin-stack';
  const coinCount = pot >= 100 ? 5 : pot >= 50 ? 4 : 3;
  for (let i = 0; i < coinCount; i++) {
    const coin = document.createElement('div');
    coin.className = 'coin';
    stack.appendChild(coin);
  }
  container.appendChild(stack);

  // Numeric value
  const value = document.createElement('span');
  value.className = 'pot-value';
  value.textContent = String(pot);
  container.appendChild(value);

  return container;
}
