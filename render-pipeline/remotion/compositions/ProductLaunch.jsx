const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence } = require('remotion');

// Three-beat reveal, each beat its own Sequence (Remotion's native way to time-slice a
// composition) with its own spring-in — a real staged animation, not three static cards.
function Beat({ children, delay, fps }) {
  const frame = useCurrentFrame();
  const s = spring({ frame: frame - delay, fps, config: { damping: 12 }, durationInFrames: 16 });
  const opacity = interpolate(frame - delay, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return React.createElement('div', { style: { transform: `scale(${Math.max(0, s)})`, opacity } }, children);
}

function ProductLaunch({ product_name = 'Your Product', tagline = 'The next big thing.' }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return React.createElement(AbsoluteFill, { style: { background: 'linear-gradient(135deg,#7C3AED,#4C1D95)', justifyContent: 'center', alignItems: 'center', fontFamily: 'Arial, sans-serif' } },
    React.createElement(Sequence, { from: 0, durationInFrames: 90 },
      React.createElement(Beat, { delay: 0, fps },
        React.createElement('div', { style: { fontSize: 30, color: '#E9D5FF', letterSpacing: 4, textTransform: 'uppercase' } }, 'Introducing')
      )
    ),
    frame >= 20 && React.createElement(Beat, { delay: 20, fps },
      React.createElement('div', { style: { fontSize: 64, fontWeight: 900, color: '#fff', textAlign: 'center', padding: '0 30px', marginTop: 16 } }, product_name)
    ),
    frame >= 45 && React.createElement(Beat, { delay: 45, fps },
      React.createElement('div', { style: { fontSize: 28, color: '#fff', opacity: 0.9, marginTop: 20, textAlign: 'center', padding: '0 40px' } }, tagline)
    ),
  );
}

module.exports = { ProductLaunch };
