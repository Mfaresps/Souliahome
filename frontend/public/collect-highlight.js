/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COLLECT BUTTON HIGHLIGHT MANAGER
 * Manages visual effects, animations, and interactions for the تحصيل (Collect) button
 * Fully responsive, accessible, and integrates with Soulia's design system
 * ═══════════════════════════════════════════════════════════════════════════
 */

const CollectHighlight = {
  /**
   * Initialize the collect button highlight effects
   * Call this after the page loads or when new collect buttons are added to the DOM
   */
  init() {
    this.applyCollectClasses();
    this.setupDropdownHighlight();
    this.setupCollectActions();
    this.setupPageLoadHighlight();
  },

  /**
   * Apply the btn-collect class to all collect buttons
   * Looks for buttons with specific onclick handlers or text content
   */
  applyCollectClasses() {
    // Target buttons in modal dialogs with تحصيل text
    const modalCollectBtns = document.querySelectorAll(
      'button[onclick*="doCollectMovement"], ' +
      'button[onclick*="doCollectMovement"]'
    );

    modalCollectBtns.forEach(btn => {
      if (!btn.classList.contains('btn-collect')) {
        btn.classList.add('btn-collect');
      }
    });

    // Target collect buttons in invoice detail view
    const invoiceCollectBtns = Array.from(
      document.querySelectorAll('button')
    ).filter(btn =>
      btn.textContent.includes('تحصيل') &&
      btn.classList.contains('btn-primary')
    );

    invoiceCollectBtns.forEach(btn => {
      if (!btn.classList.contains('btn-collect')) {
        btn.classList.add('btn-collect');
      }
    });
  },

  /**
   * Apply highlight to collect items in dropdown menus
   */
  setupDropdownHighlight() {
    // Use a MutationObserver to watch for dynamically added dropdowns
    const observer = new MutationObserver(() => {
      const ddItems = document.querySelectorAll('.dd-item');

      ddItems.forEach(item => {
        const hasCollectText = item.textContent.includes('تحصيل');

        if (hasCollectText && !item.classList.contains('collect-action')) {
          item.classList.add('collect-action');
        }
      });
    });

    // Start observing the document for changes
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
    });

    // Initial check
    document.querySelectorAll('.dd-item').forEach(item => {
      if (item.textContent.includes('تحصيل')) {
        item.classList.add('collect-action');
      }
    });
  },

  /**
   * Set up event listeners for collect actions
   */
  setupCollectActions() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button[onclick*="doCollectMovement"]');
      if (!btn) return;

      // Add loading state
      const originalText = btn.innerHTML;
      btn.classList.add('loading');
      btn.disabled = true;

      // Wait for the actual API call to complete
      // The loading state will be removed by the saveTx function's finally block
      this.watchForCollectCompletion(btn, originalText);
    });
  },

  /**
   * Watch for collect movement completion and update button state
   */
  watchForCollectCompletion(btn, originalText) {
    // Check every 100ms if the button is still disabled
    // When the API call completes, the button will be re-enabled
    const checkInterval = setInterval(() => {
      if (!btn.disabled && btn.classList.contains('loading')) {
        clearInterval(checkInterval);
        btn.classList.remove('loading');
        btn.classList.add('success');

        // Remove success animation after completion
        setTimeout(() => {
          btn.classList.remove('success');
        }, 1000);
      }
    }, 100);

    // Failsafe: clear interval after 10 seconds
    setTimeout(() => clearInterval(checkInterval), 10000);
  },

  /**
   * Add highlight flash when page loads or new transaction is added
   * Call this when a new transaction with pending collection is detected
   */
  setupPageLoadHighlight() {
    // Add subtle flash to collect buttons on page load
    setTimeout(() => {
      const collectBtns = document.querySelectorAll('.btn-collect');
      if (collectBtns.length > 0) {
        // Only highlight the first one on page load
        const firstBtn = collectBtns[0];
        firstBtn.classList.add('highlight-flash');

        // Remove the animation class after it completes
        setTimeout(() => {
          firstBtn.classList.remove('highlight-flash');
        }, 1200);
      }
    }, 800);
  },

  /**
   * Highlight a specific collect button with the flash animation
   * Useful when a new transaction with pending collection is added
   * @param {HTMLElement} btn - The collect button to highlight
   */
  flashButton(btn) {
    if (!btn) return;

    btn.classList.add('highlight-flash');
    setTimeout(() => {
      btn.classList.remove('highlight-flash');
    }, 1200);
  },

  /**
   * Add a pending collection badge to a button
   * Shows a red dot indicator on the button
   * @param {HTMLElement} btn - The collect button
   */
  addPendingBadge(btn) {
    if (!btn) return;
    if (btn.classList.contains('has-pending')) return;

    btn.classList.add('has-pending');
  },

  /**
   * Remove the pending collection badge from a button
   * @param {HTMLElement} btn - The collect button
   */
  removePendingBadge(btn) {
    if (!btn) return;
    btn.classList.remove('has-pending');
  },

  /**
   * Update all collect buttons to show pending state if there are pending collections
   * Call this when the transaction list is refreshed
   */
  updatePendingBadges() {
    // This should be called with the transactions list
    // Check if there are pending collections and highlight buttons accordingly
    const collectBtns = document.querySelectorAll('.btn-collect');

    collectBtns.forEach(btn => {
      // Check if this button's transaction has pending collection
      // You can customize this based on your data structure
      const isPending = this.hasTransactionPending(btn);

      if (isPending) {
        this.addPendingBadge(btn);
      } else {
        this.removePendingBadge(btn);
      }
    });
  },

  /**
   * Check if a button's transaction has pending collection
   * Customize this based on how you identify transactions
   * @param {HTMLElement} btn - The collect button
   * @returns {boolean} - true if transaction has pending collection
   */
  hasTransactionPending(btn) {
    // Extract transaction ID from onclick attribute
    const onclickAttr = btn.getAttribute('onclick');
    if (!onclickAttr) return false;

    const match = onclickAttr.match(/doCollectMovement\('([^']+)'\)/);
    if (!match) return false;

    const txId = match[1];

    // Check if this transaction exists in the global transactions array
    if (typeof transactions === 'undefined') return false;

    const tx = transactions.find(t => t._id === txId);
    if (!tx) return false;

    // Return true if there's a remaining balance
    return (tx.remaining || 0) > 0 && !tx.cancelled;
  },

  /**
   * Enable/disable the loading state on a collect button
   * @param {HTMLElement} btn - The collect button
   * @param {boolean} isLoading - true to show loading state, false to hide
   */
  setLoading(btn, isLoading) {
    if (!btn) return;

    if (isLoading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  },

  /**
   * Show success state on a collect button
   * @param {HTMLElement} btn - The collect button
   */
  showSuccess(btn) {
    if (!btn) return;

    btn.classList.add('success');
    btn.classList.remove('loading');
    btn.disabled = true;

    setTimeout(() => {
      btn.classList.remove('success');
      btn.disabled = false;
    }, 1200);
  },

  /**
   * Reset a collect button to its normal state
   * @param {HTMLElement} btn - The collect button
   */
  reset(btn) {
    if (!btn) return;

    btn.classList.remove('loading', 'success', 'highlight-flash', 'has-pending');
    btn.disabled = false;
  },

  /**
   * Helper: Get all collect buttons currently in the DOM
   * @returns {NodeListOf<Element>} - All collect buttons
   */
  getAll() {
    return document.querySelectorAll('.btn-collect');
  },

  /**
   * Helper: Get a specific collect button by transaction ID
   * @param {string} txId - The transaction ID
   * @returns {HTMLElement|null} - The button element or null
   */
  getByTransactionId(txId) {
    const selector = `button[onclick*="doCollectMovement('${txId}')"]`;
    return document.querySelector(selector);
  },
};

// Auto-initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    CollectHighlight.init();
  });
} else {
  CollectHighlight.init();
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CollectHighlight;
}
