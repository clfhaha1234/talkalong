// Setup for the jsdom (component-render) vitest project: registers
// @testing-library/jest-dom's custom matchers (toBeInTheDocument, toBeVisible,
// …) and auto-cleans the DOM between tests.
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom doesn't implement these and throws "Not implemented" when components
// call them in effects. StoryScreen scrolls the feed via Element.scrollTo on
// every page change, and StageFrame drives <video>.play() when a clip exists.
// Stub both to no-ops so render tests exercise the markup, not the media stack.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
} else {
  vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(() => {});
}
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
}

afterEach(() => {
  cleanup();
});
