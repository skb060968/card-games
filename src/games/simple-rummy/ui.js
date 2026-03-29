/**
 * Simple Rummy — UI Module
 *
 * Renders gameplay screen: fan hand, draw/discard piles,
 * opponent hands, turn indicator, win display.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Simple Rummy gameplay screen.
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {object} callbacks - { onDrawPileTap, onDiscardPileTap, onHandCardTap }
 */
export function renderGameplay(state, localPlayerIndex, callbacks) {
  const opponentArea = document.getElementById('sr-opponents');
  const pileArea = document.getElementById('sr-piles');
  const handArea = document.getElementById('sr-hand-area');
  const turnIndicator = document.getElementById('sr-turn-indicator');

  if (!opponentArea || !pileArea || !handArea) return;

  // Opponents
  const opponents = state.players
    .map((p, i) => ({ ...p, index: i, cardCount: p.hand.length }))
    .filter((_, i) => i !== localPlayerIndex);
  renderOpponentHands(opponentArea, opponents, state.currentPlayerIndex);

  // Piles
  const isMyDrawPhase = state.currentPlayerIndex === localPlayerIndex && state.turnPhase === 'draw';
  renderPiles(pileArea, state, isMyDrawPhase, callbacks);

  // Local hand
  const isMyDiscardPhase = state.currentPlayerIndex === localPlayerIndex && state.turnPhase === 'discard';
  renderFanHand(handArea, state.players[localPlayerIndex].hand, isMyDiscardPhase, callbacks.onHandCardTap);

  // Turn indicator
  if (turnIndicator) {
    const current = state.players[state.currentPlayerIndex];
    if (state.currentPlayerIndex === localPlayerIndex) {
      turnIndicator.textContent = state.turnPhase === 'draw'
        ? '🎯 Your turn — pick a card'
        : '🎯 Your turn — discard a card';
    } else {
      turnIndicator.textContent = `⏳ ${current.emoji} ${current.name}'s turn`;
    }
  }
}

/* ======= FAN HAND ======= */

/**
 * Renders the local player's hand as a horizontal fan layout.
 * @param {HTMLElement} container
 * @param {Array<{rank: string, suit: string}>} hand
 * @param {boolean} canDiscard
 * @param {Function} onCardTap - callback(handIndex)
 */
export function renderFanHand(container, hand, canDiscard, onCardTap) {
  container.innerHTML = '';

  const fan = document.createElement('div');
  fan.className = 'sr-fan';

  hand.forEach((card, i) => {
    const cardEl = renderCardFace(card);
    cardEl.dataset.handIndex = String(i);
    cardEl.classList.add('sr-fan-card');

    if (canDiscard) {
      cardEl.classList.add('sr-discardable');
      cardEl.addEventListener('click', () => onCardTap(i));
    }

    fan.appendChild(cardEl);
  });

  container.appendChild(fan);
}

/* ======= PILES ======= */

/**
 * Renders draw pile and discard pile side by side.
 */
function renderPiles(container, state, isMyDrawPhase, callbacks) {
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'sr-piles-row';

  // Draw pile
  const drawPileEl = document.createElement('div');
  drawPileEl.className = 'sr-pile sr-draw-pile';
  if (isMyDrawPhase) drawPileEl.classList.add('sr-pile-tappable');

  if (state.drawPile.length > 0) {
    const back = renderCardBack();
    drawPileEl.appendChild(back);
  } else {
    const empty = document.createElement('div');
    empty.className = 'sr-pile-empty';
    empty.textContent = '—';
    drawPileEl.appendChild(empty);
  }

  const drawCount = document.createElement('span');
  drawCount.className = 'sr-pile-count';
  drawCount.textContent = `Draw: ${state.drawPile.length}`;
  drawPileEl.appendChild(drawCount);

  if (isMyDrawPhase && state.drawPile.length > 0) {
    drawPileEl.addEventListener('click', () => callbacks.onDrawPileTap());
  }

  // Discard pile
  const discardPileEl = document.createElement('div');
  discardPileEl.className = 'sr-pile sr-discard-pile';
  if (isMyDrawPhase) discardPileEl.classList.add('sr-pile-tappable');

  if (state.discardPile.length > 0) {
    const topCard = state.discardPile[state.discardPile.length - 1];
    const face = renderCardFace(topCard);
    face.style.cursor = isMyDrawPhase ? 'pointer' : 'default';
    discardPileEl.appendChild(face);
  } else {
    const empty = document.createElement('div');
    empty.className = 'sr-pile-empty';
    empty.textContent = '—';
    discardPileEl.appendChild(empty);
  }

  const discardCount = document.createElement('span');
  discardCount.className = 'sr-pile-count';
  discardCount.textContent = `Discard: ${state.discardPile.length}`;
  discardPileEl.appendChild(discardCount);

  if (isMyDrawPhase && state.discardPile.length > 0) {
    discardPileEl.addEventListener('click', () => callbacks.onDiscardPileTap());
  }

  wrapper.appendChild(drawPileEl);
  wrapper.appendChild(discardPileEl);
  container.appendChild(wrapper);
}

/* ======= OPPONENT HANDS ======= */

/**
 * Renders opponent hands as card backs with count.
 */
function renderOpponentHands(container, opponents, currentPlayerIndex) {
  container.innerHTML = '';

  opponents.forEach((opp) => {
    const slot = document.createElement('div');
    slot.className = 'sr-opponent-slot';
    if (opp.index === currentPlayerIndex) slot.classList.add('active-turn');

    const emoji = document.createElement('span');
    emoji.className = 'sr-opponent-emoji';
    emoji.textContent = opp.emoji;

    const name = document.createElement('span');
    name.className = 'sr-opponent-name';
    name.textContent = opp.name;

    const count = document.createElement('span');
    count.className = 'sr-opponent-count';
    count.textContent = `🃏 ${opp.cardCount}`;

    slot.appendChild(emoji);
    slot.appendChild(name);
    slot.appendChild(count);
    container.appendChild(slot);
  });
}

/* ======= WIN DISPLAY ======= */

/**
 * Renders the winning hand grouped into sets/sequences.
 * @param {Array<Array<{rank: string, suit: string}>>} groups
 * @param {{name: string, emoji: string}} winner
 */
export function renderWinDisplay(groups, winner) {
  const display = document.getElementById('sr-winner-display');
  if (!display) return;

  display.innerHTML = '';

  const emojiEl = document.createElement('div');
  emojiEl.className = 'winner-emoji';
  emojiEl.textContent = winner.emoji;

  const nameEl = document.createElement('div');
  nameEl.className = 'winner-name';
  nameEl.textContent = `${winner.name} wins!`;

  display.appendChild(emojiEl);
  display.appendChild(nameEl);

  // Show grouped cards
  const groupsContainer = document.createElement('div');
  groupsContainer.className = 'sr-win-groups';

  groups.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'sr-win-group';

    group.forEach((card) => {
      const cardEl = renderCardFace(card);
      cardEl.style.cursor = 'default';
      groupEl.appendChild(cardEl);
    });

    groupsContainer.appendChild(groupEl);
  });

  display.appendChild(groupsContainer);
}

/* ======= RESULTS ======= */

/**
 * Renders the results screen.
 * @param {object} state
 */
export function renderResults(state) {
  const display = document.getElementById('sr-winner-display');
  const bountyList = document.getElementById('sr-results-list');

  if (display) {
    display.innerHTML = '';
    if (state.winnerIndex != null && state.winGroups) {
      renderWinDisplay(state.winGroups, state.players[state.winnerIndex]);
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (bountyList) {
    bountyList.innerHTML = '';
    state.players.forEach((player) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = `🃏 ${player.hand.length} cards`;
      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      bountyList.appendChild(li);
    });
  }
}

/* ======= LOBBY ======= */

/**
 * Renders lobby player list.
 */
export function renderLobbyPlayers(players) {
  const list = document.getElementById('sr-lobby-player-list');
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

export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = document.getElementById('sr-ready-indicators');
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
