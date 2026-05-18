export function leaderLineGeometry(
  badgeAnchor: { x: number; y: number },
  targetAnchor: { x: number; y: number },
): { length: number; angle: number } {
  const dx = targetAnchor.x - badgeAnchor.x;
  const dy = targetAnchor.y - badgeAnchor.y;
  return {
    length: Math.sqrt(dx * dx + dy * dy),
    angle: Math.atan2(dy, dx),
  };
}
