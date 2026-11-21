import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { engineLinksInSource, engineFindHallucinatedLink, engineFindAiMeta, engineStripAiMeta, engineStripLink, engineBuildFaqSystemPrompt, ENGINE_NO_INVENTED_LINK_RULE } from './worker.js';

const BAD = `Okay, I can share a demo video that explains more about how AI consulting can help your travel agency.

Here's the link: [https://www.youtube.com/watch?v=your-demo-video-link-here] (Please note: I'm an AI and cannot actually provide a live video link. In a real scenario, I would provide the actual link to a relevant demo video.)

This video will give you a good overview of how we can tailor AI solutions.`;

describe('invented demo-video link (AI consulting bot)', () => {
  it('flags the placeholder YouTube link when the prompt has no such URL', () => {
    const allowed = engineLinksInSource('We help travel agencies with AI. Demo video available on request.');
    assert.equal(engineFindHallucinatedLink(BAD, allowed), 'https://www.youtube.com/watch?v=your-demo-video-link-here');
  });
  it('allows a real link that is in the business prompt / KB', () => {
    const allowed = engineLinksInSource('Demo video: https://youtu.be/abc123.');
    assert.equal(engineFindHallucinatedLink('Here it is: https://youtu.be/abc123', allowed), null);
  });
  it('detects and strips the "I\'m an AI" disclaimer', () => {
    assert.ok(engineFindAiMeta(BAD));
    const out = engineStripAiMeta(engineStripLink(BAD, 'https://www.youtube.com/watch?v=your-demo-video-link-here'));
    assert.equal(engineFindAiMeta(out), null);
    assert.ok(!out.includes('youtube'));
    assert.ok(!out.includes('[]'));
    assert.ok(out.includes('tailor AI solutions'));
  });
  it('does not flag normal replies', () => {
    assert.equal(engineFindAiMeta('Our AI tools can automate your bookings.'), null);
  });
  it('FAQ prompt carries the link rule for every industry', () => {
    const sys = engineBuildFaqSystemPrompt({ main_prompt: 'AI consulting', language: 'en' }, { activeHistory: [] }, '', 'general', 'en', false, '');
    assert.ok(sys.includes(ENGINE_NO_INVENTED_LINK_RULE.trim()));
  });
});
