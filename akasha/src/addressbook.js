import { isAddress, getAddress } from 'viem';

/**
 * In-memory contacts store with checksum validation.
 *
 * Names are unique keys; addresses are stored in EIP-55 checksummed form.
 */
export class AddressBook {
  constructor() {
    /** @type {Map<string, string>} name -> checksummed address */
    this._contacts = new Map();
  }

  /**
   * Add a contact. Validates the address and stores it checksummed.
   * @param {string} name
   * @param {string} address
   * @returns {string} the checksummed address that was stored
   */
  add(name, address) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('name must be a non-empty string');
    }
    if (this._contacts.has(name)) {
      throw new Error(`duplicate name: ${name}`);
    }
    if (!isAddress(address)) {
      throw new Error(`invalid address: ${address}`);
    }
    const checksummed = getAddress(address);
    this._contacts.set(name, checksummed);
    return checksummed;
  }

  /**
   * Get a contact's checksummed address by name.
   * @param {string} name
   * @returns {string|undefined}
   */
  get(name) {
    return this._contacts.get(name);
  }

  /**
   * Remove a contact by name.
   * @param {string} name
   * @returns {boolean} true if a contact was removed
   */
  remove(name) {
    return this._contacts.delete(name);
  }

  /**
   * List all contacts.
   * @returns {Array<{name: string, address: string}>}
   */
  list() {
    return Array.from(this._contacts, ([name, address]) => ({ name, address }));
  }

  /**
   * Find a contact by address (case-insensitive).
   * @param {string} address
   * @returns {{name: string, address: string}|undefined}
   */
  findByAddress(address) {
    if (typeof address !== 'string') return undefined;
    const target = address.toLowerCase();
    for (const [name, stored] of this._contacts) {
      if (stored.toLowerCase() === target) {
        return { name, address: stored };
      }
    }
    return undefined;
  }

  /**
   * Serialize to a plain object for persistence.
   * @returns {{contacts: Array<{name: string, address: string}>}}
   */
  toJSON() {
    return { contacts: this.list() };
  }

  /**
   * Reconstruct an AddressBook from a plain object produced by toJSON().
   * @param {{contacts?: Array<{name: string, address: string}>}} obj
   * @returns {AddressBook}
   */
  static fromJSON(obj) {
    const book = new AddressBook();
    const contacts = obj && Array.isArray(obj.contacts) ? obj.contacts : [];
    for (const { name, address } of contacts) {
      book.add(name, address);
    }
    return book;
  }
}
