// Collects the ported action handlers. POST handlers are keyed by the body's `action`; GET handlers by ?action=.
import * as a from "./a-submit.js";
import * as b from "./b-review.js";
import * as c from "./c-chatterbox.js";

export const postHandlers = { ...a.handlers, ...b.handlers, ...c.handlers };
export const getHandlers = { ...a.getHandlers, ...b.getHandlers, ...c.getHandlers };
