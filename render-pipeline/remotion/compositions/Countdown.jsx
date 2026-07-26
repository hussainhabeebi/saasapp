const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } = require('remotion');

// A genuinely programmatic countdown — the number itself is computed per-frame from
// hours_left/duration, not a static string, which is the kind of thing Remotion is actually for
// (vs. the ffmpeg drawtext-card templates, which can only show fixed text per scene).
function Countdown({ hours_left = '24', offer_description = 'Limited time offer' }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const startHours = Math.max(0, Number(hours_left) || 0);
  const progress = Math.min(1, frame / durationInFrames);
  const currentHours = Math.max(0, startHours - startHours * progress).toFixed(1);
  const pulse = 1 + 0.04 * Math.sin((frame / fps) * Math.PI * 2);
  const textOpacity = interpolate(frame, [10, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, { style: { backgroundColor: '#B45309', justifyContent: 'center', alignItems: 'center', fontFamily: 'Arial, sans-serif' } },
    React.createElement('div', { style: { fontSize: 34, color: '#FEF3C7', marginBottom: 10 } }, '⏰ Offer ends in'),
    React.createElement('div', { style: { fontSize: 110, fontWeight: 900, color: '#fff', transform: `scale(${pulse})` } }, `${currentHours}h`),
    React.createElement('div', { style: { fontSize: 28, color: '#fff', marginTop: 30, opacity: textOpacity, textAlign: 'center', padding: '0 40px' } }, offer_description),
  );
}

module.exports = { Countdown };
