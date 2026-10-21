/**
 * Scrolls `element` into view inside `container` ONLY. Native
 * `scrollIntoView` also scrolls every ancestor scroller — including the whole
 * workspace column — which would hijack the user's place in the page whenever
 * the editor selection moves.
 */
export function scrollWithinBox(
  container: HTMLElement | null,
  element: HTMLElement | null,
): void {
  if (container === null || element === null) return;
  const rowRect = element.getBoundingClientRect();
  const boxRect = container.getBoundingClientRect();
  if (rowRect.top < boxRect.top) {
    container.scrollTop -= boxRect.top - rowRect.top;
  } else if (rowRect.bottom > boxRect.bottom) {
    container.scrollTop += rowRect.bottom - boxRect.bottom;
  }
}
