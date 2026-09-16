const FLOATING_MIN_HEIGHT = 240;
const FLOATING_MAX_HEIGHT = 1200;

function fittedFloatingBounds(bounds, workArea, requestedHeight) {
  if (typeof requestedHeight !== 'number' || !Number.isFinite(requestedHeight) || requestedHeight <= 0) return null;
  const availableHeight = Math.max(1, Math.floor(workArea.height));
  const height = Math.min(availableHeight, FLOATING_MAX_HEIGHT, Math.max(FLOATING_MIN_HEIGHT, Math.ceil(requestedHeight)));
  const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + availableHeight - height));
  // Content sizing must not change the user's width or horizontal placement.
  return { x: bounds.x, y, width: bounds.width, height };
}

module.exports = { FLOATING_MAX_HEIGHT, fittedFloatingBounds };
