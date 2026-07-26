const React = require('react');
const { Composition } = require('remotion');
const { FlashSale } = require('./compositions/FlashSale');
const { ProductLaunch } = require('./compositions/ProductLaunch');
const { Countdown } = require('./compositions/Countdown');
const { Testimonial } = require('./compositions/Testimonial');

// Registry — the single source of truth for which composition ids exist, their fixed
// duration/fps/resolution, and default props (used both for rendering and for the Worker's
// MARKETING_REMOTION_LIBRARY prop-schema hints). Resolution here is a per-composition default;
// lib/remotionRender.js overrides width/height per-render to match the project's target aspect.
const REGISTRY = [
  { id: 'FlashSale', component: FlashSale, durationInFrames: 90, defaultProps: { discount: '50', product_name: 'Your Product', end_date: 'Sunday' } },
  { id: 'ProductLaunch', component: ProductLaunch, durationInFrames: 105, defaultProps: { product_name: 'Your Product', tagline: 'The next big thing.' } },
  { id: 'Countdown', component: Countdown, durationInFrames: 90, defaultProps: { hours_left: '24', offer_description: 'Limited time offer' } },
  { id: 'Testimonial', component: Testimonial, durationInFrames: 105, defaultProps: { quote: 'This changed everything for us.', customer_name: 'A happy customer' } },
];

function RemotionRoot() {
  return React.createElement(React.Fragment, null,
    REGISTRY.map(c => React.createElement(Composition, {
      key: c.id,
      id: c.id,
      component: c.component,
      durationInFrames: c.durationInFrames,
      fps: 30,
      width: 1080,
      height: 1920,
      defaultProps: c.defaultProps,
    }))
  );
}

module.exports = { RemotionRoot, REGISTRY };
