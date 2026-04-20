/**
 * Simple Rummy — UI Module
 *
 * Renders gameplay screen: all-players bar with face-down strips,
 * draw/discard piles, local hand with arc layout, self info bar.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';
import { calculatePot, getPlayerMetric } from '../../shared/win-pot-calculator.js';

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Simple Rummy gameplay screen.
 * Layout: all-players bar → piles → local hand → self bar
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {object} callbacks - { onDrawPileTap, onDiscardPileTap, onHandCardTap, onReorder }
 */
export function renderGameplay(state, localPlayerIndex, callbacks) {
  const allPlayersEl = document.getElementById('sr-all-players');
  const pileArea = document.getElementById('sr-piles');
  const handArea = document.getElementById('sr-hand-area');

  if (!pileArea || !handArea) return;

  // All-players bar — compact blocks with face-down card strips
  if (allPlayersEl) {
    renderAllPlayers(allPlayersEl, state, localPlayerIndex);
  }

  // Self info bar
  renderSelfBar(state, localPlayerIndex);

  // Piles
  const isMyDrawPhase = state.currentPlayerIndex === localPlayerIndex && state.turnPhase === 'draw';
  renderPiles(pileArea, state, isMyDrawPhase, callbacks);

  // Local hand — arc/inverted-U layout
  const isMyDiscardPhase = state.currentPlayerIndex === localPlayerIndex && state.turnPhase === 'discard';
  renderArcHand(handArea, state.players[localPlayerIndex].hand, isMyDiscardPhase, callbacks.onHandCardTap, callbacks.onReorder);
}

/* ======= ALL-PLAYERS BAR ======= */

/**
 * Renders all player blocks at the top.
 * Each block: emoji + name + face-down card strip (showing card count).
 * Active turn gets gold glow. Self gets dashed border.
 */
function renderAllPlayers(container, state, localPlayerIndex) {
  container.innerHTML = '';

  state.players.forEach((player, i) => {
    if (i === localPlayerIndex) return;

    const block = document.createElement('div');
    block.className = 'game-player-block';
    block.dataset.playerIndex = String(i);
    if (i === state.currentPlayerIndex) block.classList.add('game-block-active');

    const emoji = document.createElement('span');
    emoji.className = 'game-block-emoji';
    emoji.textContent = player.emoji;

    const name = document.createElement('span');
    name.className = 'game-block-name';
    name.textContent = player.name;

    const strip = document.createElement('div');
    strip.className = 'game-card-strip';
    const count = player.hand ? player.hand.length : 10;
    for (let c = 0; c < count; c++) {
      const miniCard = document.createElement('div');
      miniCard.className = 'game-strip-card';
      strip.appendChild(miniCard);
    }

    block.appendChild(emoji);
    block.appendChild(name);
    block.appendChild(strip);
    container.appendChild(block);
  });
}

/* ======= SELF BAR ======= */

function renderSelfBar(state, localPlayerIndex) {
  const emojiEl = document.getElementById('sr-self-emoji');
  const nameEl = document.getElementById('sr-self-name');
  if (!emojiEl || !nameEl) return;
  const self = state.players[localPlayerIndex];
  if (!self) return;
  emojiEl.textContent = self.emoji;
  nameEl.textContent = self.name;
}

/* ======= ARC HAND (Inverted-U) ======= */

// Track selected card index for reordering or discard confirmation
let _selectedForMove = null;
let _selectedForDiscard = null;
// Track the index of the newly drawn card
let _newlyDrawnIndex = -1;

/**
 * Sets the index of the newly drawn card for highlighting.
 * @param {number} idx
 */
export function setNewlyDrawnIndex(idx) {
  _newlyDrawnIndex = idx;
}

/**
 * Renders the local player's hand in an inverted-U arc layout.
 *
 * Modes:
 * - Discard phase (canDiscard=true): first tap selects card (lifts + gold glow),
 *   second tap on same card confirms discard, tapping different card switches selection.
 * - Otherwise: tap to select for reorder, tap another position to move.
 */
export function renderArcHand(container, hand, canDiscard, onCardTap, onReorder) {
  container.innerHTML = '';

  const arc = document.createElement('div');
  arc.className = 'sr-arc';

  const n = hand.length;
  const maxAngle = 30;
  const maxLift = 20;

  // Dynamic card sizing: fit all cards within container width
  const containerWidth = container.offsetWidth || 360;
  const padding = 16; // left+right padding
  const availableWidth = containerWidth - padding;

  // Base card width, then shrink overlap to fit
  let cardW = 46;
  let cardH = 64;
  // Calculate needed overlap: cardW + (n-1) * (cardW + overlap) = availableWidth
  // overlap = (availableWidth - cardW) / (n - 1) - cardW  ... but we want negative overlap
  let overlap = -16; // default
  if (n > 1) {
    const neededWidth = cardW + (n - 1) * (cardW + overlap);
    if (neededWidth > availableWidth) {
      // Shrink: calculate overlap to fit
      overlap = -((n * cardW - availableWidth) / (n - 1));
      // If overlap is too extreme (cards barely visible), shrink card size too
      if (overlap < -30) {
        cardW = 38; cardH = 54;
        overlap = -((n * cardW - availableWidth) / (n - 1));
      }
      if (overlap < -28) {
        cardW = 32; cardH = 45;
        overlap = -((n * cardW - availableWidth) / (n - 1));
      }
    }
  }

  // Apply dynamic sizing via CSS custom properties
  container.style.setProperty('--sr-card-w', `${cardW}px`);
  container.style.setProperty('--sr-card-h', `${cardH}px`);
  hand.forEach((card, i) => {
    const cardEl = renderCardFace(card);
    cardEl.dataset.handIndex = String(i);
    cardEl.classList.add('sr-arc-card');

    // Apply dynamic sizing
    cardEl.style.width = `${cardW}px`;
    cardEl.style.height = `${cardH}px`;
    cardEl.style.marginLeft = i === 0 ? '0' : `${overlap}px`;

    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    const angle = t * (maxAngle / 2);
    const lift = (1 - t * t) * maxLift;
    let extraLift = 0;

    // Newly drawn card highlight (green glow)
    if (i === _newlyDrawnIndex) {
      cardEl.classList.add('sr-card-new');
    }

    if (canDiscard) {
      // Discard mode: two-tap confirm
      cardEl.classList.add('sr-discardable');
      cardEl.style.cursor = 'pointer';

      if (_selectedForDiscard === i) {
        cardEl.classList.add('sr-card-discard-selected');
        extraLift = 18;
      }

      cardEl.addEventListener('click', () => {
        if (_selectedForDiscard === i) {
          // Second tap — confirm discard
          _selectedForDiscard = null;
          _newlyDrawnIndex = -1;
          onCardTap(i);
        } else {
          // First tap or switch selection
          _selectedForDiscard = i;
          renderArcHand(container, hand, canDiscard, onCardTap, onReorder);
        }
      });
    } else {
      // Reorder mode
      cardEl.style.cursor = 'pointer';

      if (_selectedForMove === i) {
        cardEl.classList.add('sr-card-selected');
        extraLift = 18;
      }

      cardEl.addEventListener('click', () => {
        if (_selectedForMove === null || _selectedForMove === i) {
          _selectedForMove = _selectedForMove === i ? null : i;
          renderArcHand(container, hand, canDiscard, onCardTap, onReorder);
        } else {
          const from = _selectedForMove;
          _selectedForMove = null;
          if (onReorder) onReorder(from, i);
        }
      });
    }

    cardEl.style.transform = `translateY(${-lift - extraLift}px) rotate(${angle}deg)`;
    cardEl.style.zIndex = _selectedForDiscard === i || _selectedForMove === i ? '20' : String(i);

    arc.appendChild(cardEl);
  });

  container.appendChild(arc);
}

/**
 * Clears all selection states (call on phase/turn change).
 */
export function clearSelection() {
  _selectedForMove = null;
  _selectedForDiscard = null;
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

/* ======= WIN DISPLAY ======= */

/**
 * Renders the winning hand grouped into sets/sequences.
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

/* ======= WIN REVEAL ======= */

/**
 * Shows a full-screen win reveal overlay with the winner's grouped cards.
 * Returns a Promise that resolves after the specified duration.
 * @param {object} winner - { name, emoji }
 * @param {Array<Array<{rank:string, suit:string}>>} winGroups - grouped cards
 * @param {number} [duration=4000] - ms to show overlay
 * @returns {Promise<void>}
 */
export function showWinReveal(winner, winGroups, duration = 4000) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('sr-win-reveal');
    const emojiEl = document.getElementById('sr-reveal-emoji');
    const nameEl = document.getElementById('sr-reveal-name');
    const cardsEl = document.getElementById('sr-reveal-cards');

    if (!overlay || !cardsEl) { resolve(); return; }

    // Populate header
    if (emojiEl) emojiEl.textContent = winner.emoji || '🏆';
    if (nameEl) nameEl.textContent = `${winner.name} wins!`;

    // Populate grouped cards
    cardsEl.innerHTML = '';
    if (winGroups && winGroups.length > 0) {
      const groupsContainer = document.createElement('div');
      groupsContainer.className = 'sr-win-groups';

      winGroups.forEach((group) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'sr-win-group';
        group.forEach((card) => {
          const cardEl = renderCardFace(card);
          cardEl.style.cursor = 'default';
          groupEl.appendChild(cardEl);
        });
        groupsContainer.appendChild(groupEl);
      });

      cardsEl.appendChild(groupsContainer);
    }

    // Show overlay
    overlay.hidden = false;

    // Auto-dismiss after duration
    setTimeout(() => {
      overlay.hidden = true;
      resolve();
    }, duration);
  });
}

/* ======= RESULTS ======= */

/**
 * Renders the results screen.
 */
export function renderResults(state) {
  const display = document.getElementById('sr-winner-display');
  const bountyList = document.getElementById('sr-results-list');

  if (display) {
    display.innerHTML = '';
    if (state.winnerIndex != null && state.winGroups) {
      renderWinDisplay(state.winGroups, state.players[state.winnerIndex]);

      const pot = calculatePot('simple-rummy', state);
      if (pot > 0) {
        const potEl = document.createElement('div');
        potEl.className = 'winner-pot';
        potEl.textContent = `🪙 ${pot}`;
        display.appendChild(potEl);
      }
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (bountyList) {
    bountyList.innerHTML = '';
    state.players.forEach((player, i) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = getPlayerMetric('simple-rummy', state, i);
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
