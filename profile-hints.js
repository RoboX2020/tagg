/* PROTOTYPE, not loaded by index.html. Client-side mirror of the server's profile gate (worker/worker.js profileStatus), so the app
   could show what is still missing. The server stays the only authority: this never unlocks anything and never reads or sends data.
   Photo and LinkedIn details exist only on the server, so the caller passes them in (or leaves them out and gets a lower bound). */
(function (root) {
  var NEEDED = 3;
  function has(v, n) { return typeof v === "string" && v.trim().length >= n; }
  function profileHints(card, extra) {
    extra = extra || {};
    var c = card || {};
    var got = {
      name: has(c.name, 1), headline: has(c.headline, 3), about: has(c.detail, 3),
      photo: !!extra.hasPhoto, link: !!(c.links && Object.keys(c.links).some(function (k) { return has(c.links[k], 1); })),
      contact: has(c.email, 1) || has(c.phone, 1), linkedinDetails: !!extra.hasLinkedinDetails
    };
    var have = Object.keys(got).filter(function (k) { return got[k]; });
    return { have: have, count: have.length, needed: NEEDED, remaining: Math.max(0, NEEDED - have.length), complete: have.length >= NEEDED, got: got };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { profileHints: profileHints }; else root.profileHints = profileHints;
})(typeof self !== "undefined" ? self : this);
