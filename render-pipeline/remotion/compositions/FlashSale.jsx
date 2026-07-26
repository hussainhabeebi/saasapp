const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } = require('remotion');

// Real animation, not a static card: badge pops in with a spring, product name slides up,
// price/CTA fades in last — genuinely uses Remotion's frame-accurate animation (interpolate/
// spring), not something the ffmpeg drawtext-card templates can do.
function FlashSale({ discount = '50', product_name = 'Your Product', end_date = 'Sunday' }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const badgeScale = spring({ frame, fps, config: { damping: 10, stiffness: 120 }, durationInFrames: 18 });
  const nameY = interpolate(frame, [20, 40], [40, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const nameOpacity = interpolate(frame, [20, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ctaOpacity = interpolate(frame, [45, 65], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, { style: { backgroundColor: '#111111', justifyContent: 'center', alignItems: 'center', fontFamily: 'Arial, sans-serif' } },
    React.createElement('div', {
      style: {
        transform: `scale(${badgeScale})`, background: '#DC2626', color: '#fff', borderRadius: '50%',
        width: 260, height: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 20px 60px rgba(220,38,38,0.5)',
      },
    },
      React.createElement('div', { style: { fontSize: 72, fontWeight: 900 } }, `${discount}%`),
      React.createElement('div', { style: { fontSize: 28, fontWeight: 700 } }, 'OFF'),
    ),
    React.createElement('div', { style: { marginTop: 40, fontSize: 52, fontWeight: 800, color: '#fff', textAlign: 'center', padding: '0 40px', transform: `translateY(${nameY}px)`, opacity: nameOpacity } }, product_name),
    React.createElement('div', { style: { marginTop: 24, fontSize: 30, color: '#FFE600', fontWeight: 700, opacity: ctaOpacity } }, `Ends ${end_date} — Shop Now!`),
  );
}

module.exports = { FlashSale };
