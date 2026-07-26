const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } = require('remotion');

function Testimonial({ quote = 'This changed everything for us.', customer_name = 'A happy customer' }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const markScale = spring({ frame, fps, config: { damping: 9 }, durationInFrames: 20 });
  const quoteOpacity = interpolate(frame, [10, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const nameOpacity = interpolate(frame, [35, 55], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, { style: { backgroundColor: '#0F766E', justifyContent: 'center', alignItems: 'center', fontFamily: 'Georgia, serif', padding: '0 50px' } },
    React.createElement('div', { style: { fontSize: 100, color: '#5EEAD4', transform: `scale(${markScale})`, lineHeight: 0.6 } }, '“'),
    React.createElement('div', { style: { fontSize: 38, color: '#fff', textAlign: 'center', opacity: quoteOpacity, fontStyle: 'italic', marginTop: 10 } }, quote),
    React.createElement('div', { style: { fontSize: 24, color: '#99F6E4', marginTop: 24, opacity: nameOpacity } }, `— ${customer_name}`),
  );
}

module.exports = { Testimonial };
