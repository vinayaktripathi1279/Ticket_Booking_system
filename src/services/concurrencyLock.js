/**
 * Concurrency Lock Service
 * Provides fine-grained key locking for seat hold and booking operations.
 * Guarantees that simultaneous requests targeting the same seat are serialized or rejected immediately.
 */
class ConcurrencyLock {
  constructor() {
    this.activeLocks = new Set();
  }

  /**
   * Attempts to acquire locks for an array of seat keys (e.g. ['event1_seat5', 'event1_seat6'])
   * @param {Array<string>} keys 
   * @returns {boolean} true if all locks acquired, false otherwise
   */
  acquireLocks(keys) {
    // Check if any key is currently locked
    for (const key of keys) {
      if (this.activeLocks.has(key)) {
        return false;
      }
    }

    // Lock all keys atomically
    for (const key of keys) {
      this.activeLocks.add(key);
    }
    return true;
  }

  /**
   * Releases array of seat keys
   * @param {Array<string>} keys 
   */
  releaseLocks(keys) {
    for (const key of keys) {
      this.activeLocks.delete(key);
    }
  }

  /**
   * Executes an async handler within a lock context
   * @param {Array<string>} keys 
   * @param {Function} asyncFn 
   */
  async withLock(keys, asyncFn) {
    const sortedKeys = [...keys].sort();
    const acquired = this.acquireLocks(sortedKeys);
    if (!acquired) {
      const error = new Error('CONCURRENCY_CONFLICT: One or more selected seats are currently being processed by another customer.');
      error.statusCode = 409;
      throw error;
    }

    try {
      return await asyncFn();
    } finally {
      this.releaseLocks(sortedKeys);
    }
  }
}

const lockManager = new ConcurrencyLock();
module.exports = lockManager;
