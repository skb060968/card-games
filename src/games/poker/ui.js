/**
 * Poker — UI Module
 *
 * Renders gameplay screen: players bar with chip counts, cards
 * (face-up for local player, face-down for opponents), pot display,
 * action buttons, results, lobby, and ready indicators.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';
import { evaluateHand } from './engine.js';
import { renderPotDisplay } from '../../shared/win-pot-calculator.js';

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Poker gameplay screen.
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {object} callbacks - { onAction: (action) => void }
 */
export function renderGameplay(state, localPlayerIndex, callbacks) {
  const allPlayersBar = document.getElementById('pk-all-players');
  const potArea = document.getElementById('pk-pot-area');
  const cardsArea = document.getElementById('pk-cards-area');
  const actionsArea = document.getElementById('pk-actions-area');
  const eventBar = document.getElementById('pk-event-bar');

  // All players bar (opponents only)
  if (allPlayersBar) {
    renderAllPlayers(allPlayersBar, state, localPlayerIndex);
  }

  // Self bar
  renderSelfBar(state, localPlayerIndex);

  // Pot display
  if (potArea) {
    renderPot(potArea, state.pot);
  }

  // Cards area — show all players' cards
  if (cardsArea) {
    renderCards(cardsArea, state, localPlayerIndex);
  }

  // Action buttons
  if (actionsArea) {
    renderActions(actionsArea, state, localPlayerIndex, callbacks);
  }
}

/**
 * Renders all player blocks at the top (opponents only).
 * Each block: emoji + name + face-down card strip (3 cards for poker) + chip count.
 * Active turn gets gold glow. Folded players get dimmed opacity. Skips self.
 */
function renderAllPlayers(container, state, localPlayerIndex) {
  container.innerHTML = '';

  state.players.forEach((player, i) => {
    if (i === localPlayerIndex) return;

    const block = document.createElement('div');
    block.className = 'game-player-block';
    block.dataset.playerIndex = String(i);
    if (i === state.currentPlayerIndex) block.classList.add('game-block-active');
    if (player.folded) block.style.opacity = '0.4';

    const emoji = document.createElement('span');
    emoji.className = 'game-block-emoji';
    emoji.textContent = player.emoji;

    const name = document.createElement('span');
    name.className = 'game-block-name';
    name.textContent = player.name;

    const strip = document.createElement('div');
    strip.className = 'game-card-strip';
    const count = player.hand ? player.hand.length : 3;
    for (let c = 0; c < count; c++) {
      const miniCard = document.createElement('div');
      miniCard.className = 'game-strip-card';
      strip.appendChild(miniCard);
    }

    const chipsBadge = document.createElement('span');
    chipsBadge.className = 'game-block-extra';
    chipsBadge.textContent = `💰${player.chips}`;

    block.appendChild(emoji);
    block.appendChild(name);
    block.appendChild(strip);
    block.appendChild(chipsBadge);
    container.appendChild(block);
  });
}

/**
 * Renders the self bar at the bottom with emoji and name.
 */
function renderSelfBar(state, localPlayerIndex) {
  const emojiEl = document.getElementById('pk-self-emoji');
  const nameEl = document.getElementById('pk-self-name');
  if (!emojiEl || !nameEl) return;
  const self = state.players[localPlayerIndex];
  if (!self) return;
  emojiEl.textContent = self.emoji;
  nameEl.textContent = self.name;
}

/**
 * Renders the pot display.
 */
function renderPot(container, pot) {
  container.innerHTML = '';

  const potLabel = document.createElement('div');
  potLabel.className = 'pk-pot-display';
  potLabel.textContent = `🏆 Pot: ${pot}`;
  container.appendChild(potLabel);
}

/**
 * Renders cards for all players.
 * Local player sees face-up cards; opponents see face-down during betting.
 * During show/finished, all active players' cards are face-up.
 */
function renderCards(container, state, localPlayerIndex) {
  container.innerHTML = '';

  state.players.forEach((player, i) => {
    const playerCards = document.createElement('div');
    playerCards.className = 'pk-player-cards';
    if (player.folded) playerCards.classList.add('pk-cards-folded');
    if (i === state.currentPlayerIndex && state.status === 'betting') {
      playerCards.classList.add('pk-cards-active');
    }
    if (i === state.winnerIndex && state.status === 'finished' && !player.folded) {
      playerCards.classList.add('pk-cards-winner');
    }

    // Player label
    const label = document.createElement('div');
    label.className = 'pk-card-label';
    const displayName = i === localPlayerIndex ? 'You' : player.name;
    label.textContent = `${player.emoji} ${displayName}`;
    if (player.currentBet > 0) {
      const betBadge = document.createElement('span');
      betBadge.className = 'pk-bet-badge';
      betBadge.textContent = ` (bet: ${player.currentBet})`;
      label.appendChild(betBadge);
    }
    playerCards.appendChild(label);

    // Cards row
    const cardsRow = document.createElement('div');
    cardsRow.className = 'pk-cards-row';

    const showFaceUp = i === localPlayerIndex || state.status === 'show' || state.status === 'finished';

    player.hand.forEach((card) => {
      if (showFaceUp && !player.folded) {
        const cardEl = renderCardFace(card);
        cardEl.style.cursor = 'default';
        cardsRow.appendChild(cardEl);
      } else {
        const cardEl = renderCardBack();
        cardsRow.appendChild(cardEl);
      }
    });

    // Show hand ranking label during show/finished for active players
    if ((state.status === 'show' || state.status === 'finished') && !player.folded) {
      const rankLabel = document.createElement('div');
      rankLabel.className = 'pk-hand-rank';
      try {
        const eval_ = evaluateHand(player.hand);
        rankLabel.textContent = eval_.label;
      } catch (_) {
        rankLabel.textContent = '';
      }
      if (i === state.winnerIndex) {
        rankLabel.classList.add('pk-hand-rank-winner');
      }
      playerCards.appendChild(rankLabel);
    }

    playerCards.appendChild(cardsRow);
    container.appendChild(playerCards);
  });
}

/**
 * Renders action buttons based on game state and new betting rules.
 *
 * Button visibility rules:
 * 1. No bets yet (maxBet === 0): Show Bet (10) only
 * 2. Need to call (round 1): Show Call + Raise only (no Fold)
 * 3. Need to call (round 2+): Show Call + Raise + Fold
 * 4. Bets equal (round 2+): Show Raise + Show (if eligible) + Fold
 * 5. Fold is NEVER available in round 1
 */
function renderActions(container, state, localPlayerIndex, callbacks) {
  container.innerHTML = '';

  const isMyTurn = state.currentPlayerIndex === localPlayerIndex;
  const player = state.players[localPlayerIndex];

  if (state.status !== 'betting' || !isMyTurn || player.folded) {
    if (state.status === 'betting' && !player.folded) {
      const waitText = document.createElement('p');
      waitText.className = 'pk-wait-text';
      const currentName = state.players[state.currentPlayerIndex]?.name || 'Opponent';
      waitText.textContent = `Waiting for ${currentName}...`;
      container.appendChild(waitText);
    }
    return;
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'pk-action-buttons';

  // Compute state for button logic
  const activePlayers = state.players
    .map((p, i) => ({ index: i, folded: p.folded, currentBet: p.currentBet, hasActed: p.hasActed }))
    .filter((p) => !p.folded);
  const maxBet = Math.max(...activePlayers.map((p) => p.currentBet));
  const myBet = player.currentBet;
  const needToCall = maxBet - myBet;
  const allActed = activePlayers.every((p) => p.hasActed);
  const noBetsYet = maxBet === 0;

  if (noBetsYet) {
    // First player of the round — no one has bet yet
    // Show: Bet (10) only
    if (player.chips >= 10) {
      const betBtn = document.createElement('button');
      betBtn.className = 'btn primary pk-action-btn';
      betBtn.type = 'button';
      betBtn.textContent = 'Bet (10)';
      betBtn.addEventListener('click', () => {
        if (callbacks && callbacks.onAction) callbacks.onAction({ type: 'bet' });
      });
      btnRow.appendChild(betBtn);
    }
  } else if (needToCall > 0) {
    // Someone has bet and my bet is less than max
    // Show: Call + Raise, and Fold only if allActed (round 2+)
    if (player.chips >= needToCall) {
      const callBtn = document.createElement('button');
      callBtn.className = 'btn secondary pk-action-btn';
      callBtn.type = 'button';
      callBtn.textContent = `Call (${needToCall})`;
      callBtn.addEventListener('click', () => {
        if (callbacks && callbacks.onAction) callbacks.onAction({ type: 'call' });
      });
      btnRow.appendChild(callBtn);
    }

    const raiseTotalCost = needToCall + 10;
    if (player.chips >= raiseTotalCost) {
      const raiseBtn = document.createElement('button');
      raiseBtn.className = 'btn primary pk-action-btn pk-raise-btn';
      raiseBtn.type = 'button';
      raiseBtn.textContent = `Raise (${raiseTotalCost})`;
      raiseBtn.addEventListener('click', () => {
        if (callbacks && callbacks.onAction) callbacks.onAction({ type: 'raise' });
      });
      btnRow.appendChild(raiseBtn);
    }

    // Fold only after round 1 (all players have acted once)
    if (allActed) {
      const foldBtn = document.createElement('button');
      foldBtn.className = 'btn secondary pk-action-btn pk-fold-btn';
      foldBtn.type = 'button';
      foldBtn.textContent = 'Fold';
      foldBtn.addEventListener('click', () => {
        if (callbacks && callbacks.onAction) callbacks.onAction({ type: 'fold' });
      });
      btnRow.appendChild(foldBtn);
    }
  } else {
    // Bets are equal and I've already matched
    if (allActed) {
      // Round 2+: Show Raise + Show (if eligible) + Fold
      if (player.chips >= 10) {
        const raiseBtn = document.createElement('button');
        raiseBtn.className = 'btn primary pk-action-btn pk-raise-btn';
        raiseBtn.type = 'button';
        raiseBtn.textContent = 'Raise (10)';
        raiseBtn.addEventListener('click', () => {
          if (callbacks && callbacks.onAction) callbacks.onAction({ type: 'raise' });
        });
        btnRow.appendChild(raiseBtn);
      }

      if (state.showEligible) {
        const showBtn = document.createElement('button');
        showBtn.className = 'btn primary pk-action-btn pk-show-btn';
        showBtn.type = 'button';
        showBtn.textContent = '👁 Show';
        showBtn.addEventListener('click', () => {
          if (callbacks && callbacks.onAction) callbacks.onAction({ type: 'show' });
        });
        btnRow.appendChild(showBtn);
      }

      const foldBtn = document.createElement('button');
      foldBtn.className = 'btn secondary pk-action-btn pk-fold-btn';
      foldBtn.type = 'button';
      foldBtn.textContent = 'Fold';
      foldBtn.addEventListener('click', () => {
        if (callbacks && callbacks.onAction) callbacks.onAction({ type: 'fold' });
      });
      btnRow.appendChild(foldBtn);
    }
    // else: waiting for others to act — no buttons (shouldn't happen since it's my turn)
  }

  container.appendChild(btnRow);
}

/* ======= EVENT BAR ======= */

/**
 * Sets the event message bar text.
 * @param {string} message
 */
export function setEventMessage(message) {
  const bar = document.getElementById('pk-event-bar');
  if (bar) bar.textContent = message || '';
}

/* ======= RESULTS ======= */

/**
 * Renders the results screen.
 * @param {object} state
 * @param {boolean} [isFoldWin=false] — true if won by last-player-standing
 */
export function renderResults(state, isFoldWin = false) {
  const display = document.getElementById('pk-winner-display');
  const resultsList = document.getElementById('pk-results-list');

  if (display) {
    display.innerHTML = '';
    if (state.winnerIndex != null && state.players[state.winnerIndex]) {
      const winner = state.players[state.winnerIndex];
      const emojiEl = document.createElement('div');
      emojiEl.className = 'winner-emoji';
      emojiEl.textContent = winner.emoji;

      const nameEl = document.createElement('div');
      nameEl.className = 'winner-name';
      nameEl.textContent = `${winner.name} wins!`;

      display.appendChild(emojiEl);
      display.appendChild(nameEl);

      // Show pot won as coin stack (chips gained = winner.chips - 100 starting)
      const potWon = winner.chips - 100;
      if (potWon > 0) {
        display.appendChild(renderPotDisplay(potWon));
      }

      // Show hand ranking if it was a show (not fold win)
      if (!isFoldWin) {
        try {
          const eval_ = evaluateHand(winner.hand);
          const rankEl = document.createElement('div');
          rankEl.className = 'winner-bounty';
          rankEl.textContent = eval_.label;
          display.appendChild(rankEl);
        } catch (_) {}
      } else {
        const foldEl = document.createElement('div');
        foldEl.className = 'winner-bounty';
        foldEl.textContent = 'All others folded';
        display.appendChild(foldEl);
      }
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (resultsList) {
    resultsList.innerHTML = '';
    state.players.forEach((player) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const chipsSpan = document.createElement('span');
      chipsSpan.className = 'bounty-value';
      chipsSpan.textContent = `💰 ${player.chips} chips`;
      li.appendChild(nameSpan);
      li.appendChild(chipsSpan);
      resultsList.appendChild(li);
    });
  }
}

/* ======= LOBBY ======= */

/**
 * Renders lobby player list.
 * @param {Array<{name, emoji}>} players
 */
export function renderLobbyPlayers(players) {
  const list = document.getElementById('pk-lobby-player-list');
  if (!list) return;
  list.innerHTML = '';

  players.forEach((player, index) => {
    const li = document.createElement('li');
    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = player.emoji || '😀';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.name || `Player ${index + 1}`;
    nameSpan.style.flex = '1';
    li.appendChild(emojiSpan);
    li.appendChild(nameSpan);
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    }
    list.appendChild(li);
  });
}

/* ======= READY INDICATORS ======= */

/**
 * Renders ready indicators for play-again flow.
 */
export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = document.getElementById('pk-ready-indicators');
  if (!container) return;
  container.hidden = false;
  container.innerHTML = '';

  const readySet = readyPlayers instanceof Set ? readyPlayers : new Set(readyPlayers);
  const leftSet = leftPlayers instanceof Set ? leftPlayers : new Set(leftPlayers || []);

  playerNames.forEach((name, index) => {
    const dot = document.createElement('div');
    dot.className = 'ready-dot';
    if (readySet.has(index)) dot.classList.add('ready');
    if (leftSet.has(index)) dot.classList.add('not-ready');
    const circle = document.createElement('div');
    circle.className = 'dot';
    const label = document.createElement('span');
    label.className = 'dot-name';
    label.textContent = name;
    dot.appendChild(circle);
    dot.appendChild(label);
    container.appendChild(dot);
  });
}
