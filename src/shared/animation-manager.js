/**
 * Animation Manager for Card Games Platform
 *
 * Provides slide, flip, and sweep animations using CSS classes/keyframes.
 * All animations return Promises and respect prefers-reduced-motion.
 */

/**
 * Checks if the user prefers reduced motion.
 * @returns {boolean}
 */
function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Slides a card element from a source position to a target position.
 * Adds `.animate-slide` class with CSS custom properties for direction.
 * Resolves after 300ms.
 *
 * @param {HTMLElement} cardEl - The card element to animate
 * @param {DOMRect} fromRect - Source bounding rect
 * @param {DOMRect} toRect - Target bounding rect
 * @returns {Promise<void>}
 */
export function animateSlide(cardEl, fromRect, toRect) {
  if (prefersReducedMotion()) return Promise.resolve();

  const dx = fromRect.left - toRect.left;
  const dy = fromRect.top - toRect.top;

  cardEl.style.setProperty('--slide-x', `${dx}px`);
  cardEl.style.setProperty('--slide-y', `${dy}px`);
  cardEl.classList.add('animate-slide');

  return new Promise((resolve) => {
    setTimeout(() => {
      cardEl.classList.remove('animate-slide');
      cardEl.style.removeProperty('--slide-x');
      cardEl.style.removeProperty('--slide-y');
      resolve();
    }, 300);
  });
}

/**
 * Flips a card from back to face with a 3D transform.
 * Adds `.animate-flip` class, swaps content mid-flip.
 * Resolves after 400ms.
 *
 * @param {HTMLElement} cardEl - The card element to animate
 * @param {HTMLElement} faceContent - The face content to swap in mid-flip
 * @returns {Promise<void>}
 */
export function animateFlip(cardEl, faceContent) {
  if (prefersReducedMotion()) {
    cardEl.innerHTML = '';
    cardEl.appendChild(faceContent);
    return Promise.resolve();
  }

  cardEl.classList.add('animate-flip');

  // Swap content at the midpoint of the flip (200ms)
  setTimeout(() => {
    cardEl.innerHTML = '';
    cardEl.appendChild(faceContent);
  }, 200);

  return new Promise((resolve) => {
    setTimeout(() => {
      cardEl.classList.remove('animate-flip');
      resolve();
    }, 400);
  });
}

/**
 * Sweeps pile cards toward the capturing player's bounty area.
 * Adds `.animate-sweep` class with CSS custom properties for direction.
 * Resolves after 500ms.
 *
 * @param {HTMLElement} pileEl - The pile element to animate
 * @param {DOMRect} targetRect - The target bounty area bounding rect
 * @returns {Promise<void>}
 */
export function animateSweep(pileEl, targetRect) {
  if (prefersReducedMotion()) return Promise.resolve();

  const pileRect = pileEl.getBoundingClientRect();
  const dx = targetRect.left - pileRect.left;
  const dy = targetRect.top - pileRect.top;

  pileEl.style.setProperty('--sweep-x', `${dx}px`);
  pileEl.style.setProperty('--sweep-y', `${dy}px`);
  pileEl.classList.add('animate-sweep');

  return new Promise((resolve) => {
    setTimeout(() => {
      pileEl.classList.remove('animate-sweep');
      pileEl.style.removeProperty('--sweep-x');
      pileEl.style.removeProperty('--sweep-y');
      resolve();
    }, 1200);
  });
}


/**
 * Animates a card throw: creates a temporary face-down card at the deck position,
 * slides it to the pile, then flips it to reveal the card face.
 * 
 * @param {DOMRect} deckRect - Bounding rect of the deck element
 * @param {DOMRect} pileRect - Bounding rect of the pile area
 * @param {HTMLElement} cardFaceEl - The card face element to reveal after flip
 * @returns {Promise<void>}
 */
export function animateThrowToPile(deckRect, pileRect, cardFaceEl) {
  if (prefersReducedMotion()) return Promise.resolve();

  // Create a temporary floating card (face-down) for the animation
  const floater = document.createElement('div');
  floater.className = 'card throw-floater';
  floater.style.position = 'fixed';
  floater.style.left = `${deckRect.left}px`;
  floater.style.top = `${deckRect.top}px`;
  floater.style.width = `${deckRect.width}px`;
  floater.style.height = `${deckRect.height}px`;
  floater.style.zIndex = '100';
  floater.style.transition = 'left 300ms ease-out, top 300ms ease-out';
  floater.style.transformStyle = 'preserve-3d';
  floater.style.perspective = '600px';

  // Start as card back
  const backEl = document.createElement('div');
  backEl.className = 'card-back';
  backEl.style.width = '100%';
  backEl.style.height = '100%';
  floater.appendChild(backEl);

  document.body.appendChild(floater);

  return new Promise((resolve) => {
    // Double-rAF: first frame ensures the browser paints at start position,
    // second frame applies the move so older devices animate correctly.
    requestAnimationFrame(() => {
      floater.offsetWidth; // force layout at start position
      requestAnimationFrame(() => {
        floater.style.left = `${pileRect.left + (pileRect.width - deckRect.width) / 2}px`;
        floater.style.top = `${pileRect.top + (pileRect.height - deckRect.height) / 2}px`;
      });
    });

    setTimeout(() => {
      // Step 2: Flip to reveal face (400ms)
      floater.style.transition = 'transform 400ms ease-in-out';
      floater.style.transform = 'rotateY(90deg)';

      setTimeout(() => {
        // At midpoint, swap to card face
        floater.innerHTML = '';
        if (cardFaceEl) {
          const face = cardFaceEl.cloneNode(true);
          face.style.width = '100%';
          face.style.height = '100%';
          floater.appendChild(face);
        }
        floater.style.transform = 'rotateY(0deg)';

        setTimeout(() => {
          // Remove floater
          if (floater.parentNode) floater.parentNode.removeChild(floater);
          resolve();
        }, 200);
      }, 200);
    }, 320);
  });
}
