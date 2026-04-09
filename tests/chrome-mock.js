// Mock Chrome extension APIs for testing

function createChromeMock() {
  const listeners = {};

  return {
    runtime: {
      onMessage: {
        addListener: jest.fn((cb) => { listeners.onMessage = cb; }),
      },
      sendMessage: jest.fn((msg, cb) => { if (cb) cb(); }),
      lastError: null,
    },
    webRequest: {
      onResponseStarted: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
    },
    tabs: {
      onRemoved: { addListener: jest.fn() },
      onUpdated: { addListener: jest.fn() },
      query: jest.fn((q, cb) => cb([{ id: 1 }])),
    },
    action: {
      setBadgeText: jest.fn(),
      setBadgeBackgroundColor: jest.fn(),
    },
    downloads: {
      download: jest.fn((opts, cb) => { if (cb) cb(1); }),
    },
    scripting: {
      executeScript: jest.fn((opts, cb) => { if (cb) cb([{ result: [] }]); }),
    },
    offscreen: {
      hasDocument: jest.fn(() => Promise.resolve(false)),
      createDocument: jest.fn(() => Promise.resolve()),
      closeDocument: jest.fn(() => Promise.resolve()),
    },
    permissions: {
      contains: jest.fn((p, cb) => cb(false)),
      request: jest.fn((p, cb) => cb(true)),
    },
    _listeners: listeners,
  };
}

module.exports = { createChromeMock };
